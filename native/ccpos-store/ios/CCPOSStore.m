// Cashu Card POS (slice 0.3): the journal's directory under Application Support, excluded from backup and readable after
// the first unlock, and the file operations the store needs. JavaScript reaches it as NativeModules.CCPOSStore.
#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface CCPOSStore : NSObject <RCTBridgeModule>
@end

@implementation CCPOSStore

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

static BOOL validName(NSString *name)
{
  if (name == nil) {
    return NO;
  }
  NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"^[a-z0-9-]{1,32}$" options:0 error:nil];
  return [re numberOfMatchesInString:name options:0 range:NSMakeRange(0, name.length)] == 1;
}

static void rejectWith(RCTPromiseRejectBlock reject, NSString *code, NSString *what, NSError *err)
{
  reject(code, [NSString stringWithFormat:@"%@: %@", what, err ? err.localizedDescription : @"failed"], err);
}

RCT_EXPORT_METHOD(journalDir:(NSString *)name resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (!validName(name)) {
    return reject(@"name", @"a directory name is 1 to 32 of a-z 0-9 -", nil);
  }
  NSFileManager *fm = [NSFileManager defaultManager];
  NSError *err = nil;
  NSURL *base = [fm URLForDirectory:NSApplicationSupportDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:&err];
  if (base == nil) {
    return rejectWith(reject, @"dir", @"no Application Support directory", err);
  }
  NSURL *dir = [base URLByAppendingPathComponent:name isDirectory:YES];
  NSDictionary *attrs = @{NSFileProtectionKey: NSFileProtectionCompleteUntilFirstUserAuthentication};
  if (![fm createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:attrs error:&err]) {
    return rejectWith(reject, @"dir", @"the directory could not be made", err);
  }
  if (![dir setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&err]) {
    return rejectWith(reject, @"backup", @"the directory could not be excluded from backup", err);
  }
  resolve(dir.path);
}

RCT_EXPORT_METHOD(exists:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  resolve(@([[NSFileManager defaultManager] fileExistsAtPath:path]));
}

RCT_EXPORT_METHOD(excludeFromBackup:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    return resolve(@NO);
  }
  NSURL *u = [NSURL fileURLWithPath:path];
  NSError *err = nil;
  if (![u setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&err]) {
    return rejectWith(reject, @"backup", @"the file could not be excluded from backup", err);
  }
  resolve(@YES);
}

RCT_EXPORT_METHOD(isExcludedFromBackup:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    return resolve(@NO);
  }
  NSURL *u = [NSURL fileURLWithPath:path];
  [u removeAllCachedResourceValues];
  NSNumber *v = nil;
  NSError *err = nil;
  if (![u getResourceValue:&v forKey:NSURLIsExcludedFromBackupKey error:&err]) {
    return rejectWith(reject, @"backup", @"the backup flag could not be read", err);
  }
  resolve(@([v boolValue]));
}

RCT_EXPORT_METHOD(move:(NSString *)from to:(NSString *)to resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  NSFileManager *fm = [NSFileManager defaultManager];
  if (![fm fileExistsAtPath:from]) {
    return reject(@"move", @"nothing to move", nil);
  }
  if ([fm fileExistsAtPath:to]) {
    return reject(@"move", @"the target exists", nil);
  }
  NSError *err = nil;
  if (![fm moveItemAtPath:from toPath:to error:&err]) {
    return rejectWith(reject, @"move", @"the file could not be moved", err);
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(removeLabFile:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (![[path lastPathComponent] hasPrefix:@"lab-"]) {
    return reject(@"lab", @"only a lab- file may be removed", nil);
  }
  NSFileManager *fm = [NSFileManager defaultManager];
  if (![fm fileExistsAtPath:path]) {
    return resolve(nil);
  }
  NSError *err = nil;
  if (![fm removeItemAtPath:path error:&err]) {
    return rejectWith(reject, @"lab", @"the file could not be removed", err);
  }
  resolve(nil);
}

@end
