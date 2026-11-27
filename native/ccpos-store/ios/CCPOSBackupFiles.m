#import "CCPOSBackupKey.h"
#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <fcntl.h>
#import <unistd.h>

static const NSUInteger CCPOSMaxDocument = 24 * 1024 * 1024;

static BOOL validBackup(NSString *file) {
  return file.length <= CCPOSMaxDocument && [file hasPrefix:@"CASHU-POS-BACKUP-1\n"] &&
      [file canBeConvertedToEncoding:NSASCIIStringEncoding];
}

static NSString *backupName(void) {
  NSISO8601DateFormatter *date = [NSISO8601DateFormatter new];
  date.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSString *stamp = [[date stringFromDate:NSDate.date] stringByReplacingOccurrencesOfString:@":" withString:@"-"];
  return [NSString stringWithFormat:@"Cashu-POS-%@-%@.cashupos", stamp, NSUUID.UUID.UUIDString];
}

static NSURL *bookmarkFile(void) {
  NSFileManager *fm = NSFileManager.defaultManager;
  NSURL *base = [fm URLForDirectory:NSApplicationSupportDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:nil];
  NSURL *dir = [base URLByAppendingPathComponent:@"cashupos-folder" isDirectory:YES];
  if (![fm createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionComplete} error:nil] ||
      ![dir setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil]) return nil;
  return [dir URLByAppendingPathComponent:@"location"];
}

static BOOL fileMatches(NSURL *file, NSData *bytes) {
  if (!bytes || !file.isFileURL) return NO;
  NSInputStream *stream = [NSInputStream inputStreamWithURL:file];
  uint8_t chunk[16384];
  size_t count = 0;
  NSInteger n;
  [stream open];
  while ((n = [stream read:chunk maxLength:sizeof(chunk)]) > 0) {
    if ((NSUInteger)n > bytes.length - count || memcmp(chunk, (const uint8_t *)bytes.bytes + count, (size_t)n) != 0) break;
    count += (size_t)n;
  }
  [stream close];
  return n == 0 && count == bytes.length;
}

// Verify each byte after closing the provider's writer. Keep all earlier files.
static BOOL writeUniqueAndVerify(NSURL *file, NSData *bytes) {
  int fd = open(file.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd == -1) return NO;
  size_t offset = 0;
  while (offset < bytes.length) {
    ssize_t written = write(fd, (const uint8_t *)bytes.bytes + offset, bytes.length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) break;
    offset += (size_t)written;
  }
  BOOL complete = offset == bytes.length && fsync(fd) == 0;
  if (close(fd) != 0) complete = NO;
  if (complete) complete = fileMatches(file, bytes);
  if (!complete) [[NSFileManager defaultManager] removeItemAtURL:file error:nil];
  return complete;
}

// All picker state is owned by the main queue. The document provider sees encrypted bytes only.
@interface CCPOSBackupFiles : NSObject <RCTBridgeModule, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate>
@property(nonatomic, copy) RCTPromiseResolveBlock resolve;
@property(nonatomic, copy) RCTPromiseRejectBlock reject;
@property(nonatomic, strong) NSURL *temporary;
@property(nonatomic) BOOL choosingFolder;
@property(nonatomic, strong) UIDocumentPickerViewController *picker;
@end

@implementation CCPOSBackupFiles
RCT_EXPORT_MODULE()

RCT_EXPORT_METHOD(deriveKey:(NSString *)passwordHex salt:(NSString *)saltHex
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (passwordHex.length < 2 || passwordHex.length > 512 || passwordHex.length % 2 || saltHex.length != 32) {
    reject(@"backup_key", @"Invalid backup key input.", nil);
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    long passLen = 0, saltLen = 0;
    unsigned char *pass = OPENSSL_hexstr2buf(passwordHex.UTF8String, &passLen);
    unsigned char *salt = OPENSSL_hexstr2buf(saltHex.UTF8String, &saltLen);
    unsigned char key[32];
    NSString *result = nil;
    if (pass && salt && passLen == (long)passwordHex.length / 2 && saltLen == 16 &&
        ccpos_backup_key(pass, (size_t)passLen, salt, key) == 1) {
      const char alphabet[] = "0123456789abcdef";
      char hex[sizeof(key) * 2];
      for (size_t i = 0; i < sizeof(key); ++i) {
        hex[2*i] = alphabet[key[i] >> 4];
        hex[2*i+1] = alphabet[key[i] & 15];
      }
      result = [[NSString alloc] initWithBytes:hex length:sizeof(hex) encoding:NSASCIIStringEncoding];
      OPENSSL_cleanse(hex, sizeof(hex));
    }
    OPENSSL_cleanse(key, sizeof(key));
    OPENSSL_clear_free(pass, passLen);
    OPENSSL_free(salt);
    if (result) resolve(result);
    else reject(@"backup_key", @"The backup key could not be derived.", nil);
  });
}
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (void)finish:(id)value error:(NSString *)message
{
  RCTPromiseResolveBlock resolve = self.resolve;
  RCTPromiseRejectBlock reject = self.reject;
  self.resolve = nil;
  self.reject = nil;
  self.picker = nil;
  self.choosingFolder = NO;
  if (self.temporary) {
    [[NSFileManager defaultManager] removeItemAtURL:self.temporary error:nil];
    self.temporary = nil;
  }
  if (message && reject) reject(@"document_error", message, nil);
  else if (resolve) resolve(value);
}

- (BOOL)begin:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (self.resolve || !RCTPresentedViewController().view.window) {
    reject(@"document_busy", @"Return to the till and try again.", nil);
    return NO;
  }
  self.resolve = resolve;
  self.reject = reject;
  return YES;
}

- (void)present:(UIDocumentPickerViewController *)picker
{
  UIViewController *presenter = RCTPresentedViewController();
  if (!presenter.view.window || presenter.isBeingDismissed) {
    [self finish:nil error:@"The system document picker is unavailable."];
    return;
  }
  self.picker = picker;
  picker.delegate = self;
  picker.allowsMultipleSelection = NO;
  picker.presentationController.delegate = self;
  [presenter presentViewController:picker animated:YES completion:nil];
}

RCT_EXPORT_METHOD(chooseFolder:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (![self begin:resolve reject:reject]) return;
  self.choosingFolder = YES;
  [self present:[[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypeFolder] asCopy:NO]];
}

RCT_EXPORT_METHOD(writeCopy:(NSString *)encrypted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (!validBackup(encrypted)) { reject(@"document_invalid", @"Choose a Cashu POS encrypted backup.", nil); return; }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSURL *record = bookmarkFile();
    NSData *bookmark = record ? [NSData dataWithContentsOfURL:record] : nil;
    BOOL stale = NO;
    NSURL *folder = bookmark ? [NSURL URLByResolvingBookmarkData:bookmark options:0 relativeToURL:nil
                                            bookmarkDataIsStale:&stale error:nil] : nil;
    if (stale || ![folder startAccessingSecurityScopedResource]) {
      reject(@"recovery_folder", @"Choose your recovery folder again.", nil); return;
    }
    NSError *error = nil;
    __block BOOL verified = NO;
    NSURL *file = [folder URLByAppendingPathComponent:backupName()];
    NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
    [coordinator coordinateWritingItemAtURL:file options:0 error:&error byAccessor:^(NSURL *destination) {
      verified = writeUniqueAndVerify(destination, [encrypted dataUsingEncoding:NSASCIIStringEncoding]);
    }];
    [folder stopAccessingSecurityScopedResource];
    if (verified && !error) resolve(@YES);
    else reject(@"recovery_folder", @"Choose your recovery folder again and verify that it has free space.", nil);
  });
}

RCT_EXPORT_METHOD(open:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (![self begin:resolve reject:reject]) return;
  [self present:[[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypeData] asCopy:NO]];
}

RCT_EXPORT_METHOD(save:(NSString *)encrypted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (![self begin:resolve reject:reject]) return;
  if (!validBackup(encrypted)) {
    [self finish:nil error:@"This backup exceeds the supported file size."];
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSFileManager *fm = NSFileManager.defaultManager;
    NSURL *cache = [fm URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask].firstObject;
    NSURL *dir = [cache URLByAppendingPathComponent:@"cashupos-export" isDirectory:YES];
    NSError *error = nil;
    BOOL made = [fm createDirectoryAtURL:dir withIntermediateDirectories:YES
                              attributes:@{NSFileProtectionKey:NSFileProtectionComplete} error:&error];
    // Remove a prior encrypted export left behind by an app termination.
    if (made) for (NSURL *old in [fm contentsOfDirectoryAtURL:dir includingPropertiesForKeys:nil options:0 error:nil])
      if ([old.pathExtension isEqual:@"cashupos"]) [fm removeItemAtURL:old error:nil];
    NSString *name = backupName();
    NSURL *file = [dir URLByAppendingPathComponent:name];
    BOOL saved = made && [[encrypted dataUsingEncoding:NSASCIIStringEncoding]
        writeToURL:file options:NSDataWritingAtomic | NSDataWritingFileProtectionComplete error:&error];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!saved) {
        [self finish:nil error:@"The encrypted backup could not be prepared."];
        return;
      }
      self.temporary = file;
      [self present:[[UIDocumentPickerViewController alloc] initForExportingURLs:@[file] asCopy:YES]];
    });
  });
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller
{
  if (controller == self.picker) [self finish:nil error:nil];
}

- (void)presentationControllerDidDismiss:(UIPresentationController *)presentation
{
  if (presentation.presentedViewController == self.picker) [self finish:nil error:nil];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls
{
  if (controller != self.picker) return;
  self.picker = nil;
  NSURL *url = urls.firstObject;
  if (!url.isFileURL) { [self finish:nil error:@"Choose a backup file in Files."]; return; }
  if (self.temporary) {
    NSURL *source = self.temporary;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      // Some providers return a write-only URL. In that case the merchant must
      // reopen the saved file before the app counts this backup as verified.
      __block BOOL verified = NO;
      BOOL scoped = [url startAccessingSecurityScopedResource];
      if (![url.URLByStandardizingPath isEqual:source.URLByStandardizingPath]) {
        NSData *bytes = [NSData dataWithContentsOfURL:source options:NSDataReadingMappedIfSafe error:nil];
        NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
        [coordinator coordinateReadingItemAtURL:url options:0 error:nil byAccessor:^(NSURL *destination) {
          verified = fileMatches(destination, bytes);
        }];
      }
      if (scoped) [url stopAccessingSecurityScopedResource];
      dispatch_async(dispatch_get_main_queue(), ^{ [self finish:verified ? @YES : @"verify" error:nil]; });
    });
    return;
  }
  if (self.choosingFolder) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      BOOL scoped = [url startAccessingSecurityScopedResource];
      NSData *bookmark = scoped ? [url bookmarkDataWithOptions:NSURLBookmarkCreationMinimalBookmark
                              includingResourceValuesForKeys:nil relativeToURL:nil error:nil] : nil;
      NSURL *file = bookmarkFile();
      BOOL saved = bookmark && file && [bookmark writeToURL:file options:NSDataWritingAtomic | NSDataWritingFileProtectionComplete error:nil];
      if (scoped) [url stopAccessingSecurityScopedResource];
      dispatch_async(dispatch_get_main_queue(), ^{
        [self finish:saved ? @YES : nil error:saved ? nil : @"The till could not keep access to this folder."];
      });
    });
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    BOOL scoped = [url startAccessingSecurityScopedResource];
    NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
    __block NSString *contents = nil;
    NSError *error = nil;
    [coordinator coordinateReadingItemAtURL:url options:0 error:&error byAccessor:^(NSURL *file) {
      NSNumber *regular = nil;
      if (![file getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil] || !regular.boolValue) return;
      NSInputStream *stream = [NSInputStream inputStreamWithURL:file];
      NSMutableData *data = [NSMutableData data];
      uint8_t chunk[16384];
      [stream open];
      NSInteger size;
      while ((size = [stream read:chunk maxLength:sizeof(chunk)]) > 0) {
        if ((NSUInteger)size > CCPOSMaxDocument - data.length) break;
        [data appendBytes:chunk length:(NSUInteger)size];
      }
      [stream close];
      if (size == 0 && data.length) contents = [[NSString alloc] initWithData:data encoding:NSASCIIStringEncoding];
    }];
    if (scoped) [url stopAccessingSecurityScopedResource];
    dispatch_async(dispatch_get_main_queue(), ^{
      [self finish:contents error:contents ? nil : @"The encrypted backup could not be read. Choose a Cashu POS backup."];
    });
  });
}
@end
