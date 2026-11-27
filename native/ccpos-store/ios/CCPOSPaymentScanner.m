#import <AVFoundation/AVFoundation.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>

typedef void (^ScanFinished)(BOOL completed, NSString *error);

@interface CCPOSScanController : UIViewController <AVCaptureMetadataOutputObjectsDelegate>
@property(nonatomic, copy) ScanFinished onFinish;
@property(nonatomic, copy) void (^onFrame)(NSString *);
- (void)finish:(BOOL)completed error:(NSString *)error;
@end

@implementation CCPOSScanController {
  AVCaptureSession *_session;
  AVCaptureVideoPreviewLayer *_preview;
  dispatch_queue_t _camera;
  BOOL _started;
  NSString *_previous;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = @"Scan payment QR";
  self.view.backgroundColor = UIColor.blackColor;
  self.navigationItem.leftBarButtonItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemCancel
      target:self action:@selector(cancelScan)];
  _camera = dispatch_queue_create("org.cashucard.pos.payment-camera", DISPATCH_QUEUE_SERIAL);
  _session = [AVCaptureSession new];
  _preview = [AVCaptureVideoPreviewLayer layerWithSession:_session];
  _preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
  [self.view.layer addSublayer:_preview];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(cameraFailed:)
      name:AVCaptureSessionRuntimeErrorNotification object:_session];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(appBackgrounded:)
      name:UIApplicationDidEnterBackgroundNotification object:nil];
}

- (void)viewDidLayoutSubviews {
  [super viewDidLayoutSubviews];
  _preview.frame = self.view.bounds;
  AVCaptureConnection *connection = _preview.connection;
  UIInterfaceOrientation orientation = self.view.window.windowScene.interfaceOrientation;
  if (orientation != UIInterfaceOrientationUnknown && connection.isVideoOrientationSupported) {
    connection.videoOrientation = (AVCaptureVideoOrientation)orientation;
  }
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  if (_started || !self.onFinish) return;
  _started = YES;
  dispatch_async(_camera, ^{
    AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    AVCaptureDeviceInput *input = device ? [AVCaptureDeviceInput deviceInputWithDevice:device error:NULL] : nil;
    AVCaptureMetadataOutput *output = [AVCaptureMetadataOutput new];
    [self->_session beginConfiguration];
    BOOL ready = input && [self->_session canAddInput:input];
    if (ready) [self->_session addInput:input];
    ready = ready && [self->_session canAddOutput:output];
    if (ready) {
      [self->_session addOutput:output];
      ready = [output.availableMetadataObjectTypes containsObject:AVMetadataObjectTypeQRCode];
    }
    if (ready) {
      [output setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
      output.metadataObjectTypes = @[AVMetadataObjectTypeQRCode];
    }
    [self->_session commitConfiguration];
    if (ready) [self->_session startRunning];
    else dispatch_async(dispatch_get_main_queue(), ^{ [self cameraFailed:nil]; });
  });
}

- (void)captureOutput:(AVCaptureOutput *)output didOutputMetadataObjects:(NSArray<__kindof AVMetadataObject *> *)objects
    fromConnection:(AVCaptureConnection *)connection {
  for (AVMetadataMachineReadableCodeObject *item in objects) {
    if ([item.type isEqualToString:AVMetadataObjectTypeQRCode] && item.stringValue.length) {
      if (_previous == nil || ![_previous isEqualToString:item.stringValue]) {
        _previous = item.stringValue;
        if (self.onFrame) self.onFrame(_previous);
      }
      return;
    }
  }
}

- (void)cancelScan { [self finish:NO error:nil]; }
- (void)appBackgrounded:(NSNotification *)note { [self cancelScan]; }
- (void)cameraFailed:(NSNotification *)note {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self finish:NO error:@"The camera is unavailable. Paste the payment instead."];
  });
}

- (void)finish:(BOOL)completed error:(NSString *)error {
  ScanFinished callback = self.onFinish;
  if (!callback) return;
  self.onFinish = nil;
  self.onFrame = nil;
  _previous = nil;
  [NSNotificationCenter.defaultCenter removeObserver:self];
  AVCaptureSession *session = _session;
  dispatch_async(_camera, ^{ if (session.isRunning) [session stopRunning]; });
  [self.navigationController dismissViewControllerAnimated:YES completion:^{ callback(completed, error); }];
}
@end

@interface CCPOSPaymentScanner : RCTEventEmitter
@end

@implementation CCPOSPaymentScanner {
  NSString *_session;
  __weak CCPOSScanController *_shown;
}
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (NSArray<NSString *> *)supportedEvents { return @[@"CCPOSPaymentFrame"]; }

RCT_EXPORT_METHOD(scan:(NSString *)session resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (_session) {
    reject(@"camera_busy", @"A payment scan is already open.", nil);
    return;
  }
  _session = [session copy];
  void (^present)(BOOL) = ^(BOOL allowed) {
    dispatch_async(dispatch_get_main_queue(), ^{
      UIViewController *host = RCTPresentedViewController();
      if (!allowed || !host.view.window || host.isBeingDismissed ||
          UIApplication.sharedApplication.applicationState == UIApplicationStateBackground) {
        self->_session = nil;
        NSString *reason = allowed ? @"The camera is unavailable. Paste the payment instead."
                                   : @"Allow camera access in Settings or paste the payment.";
        reject(allowed ? @"camera_unavailable" : @"camera_denied", reason, nil);
        return;
      }
      CCPOSScanController *scanner = [CCPOSScanController new];
      self->_shown = scanner;
      scanner.onFrame = ^(NSString *value) {
        [self sendEventWithName:@"CCPOSPaymentFrame" body:@{@"session":session, @"text":value}];
      };
      scanner.onFinish = ^(BOOL completed, NSString *error) {
        self->_shown = nil;
        self->_session = nil;
        if (error) reject(@"camera_unavailable", error, nil);
        else resolve(@(completed));
      };
      UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:scanner];
      nav.modalPresentationStyle = UIModalPresentationFullScreen;
      nav.overrideUserInterfaceStyle = UIUserInterfaceStyleDark;
      [host presentViewController:nav animated:YES completion:nil];
    });
  };
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
  if (status == AVAuthorizationStatusNotDetermined) {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:present];
  } else {
    present(status == AVAuthorizationStatusAuthorized);
  }
}

RCT_EXPORT_METHOD(showProgress:(NSString *)session received:(NSInteger)received expected:(NSInteger)expected) {
  if ([_session isEqualToString:session])
    _shown.title = [NSString stringWithFormat:@"Reading moving QR · %ld of %ld", (long)received, (long)expected];
}
RCT_EXPORT_METHOD(finishScan:(NSString *)session) {
  if ([_session isEqualToString:session]) [_shown finish:YES error:nil];
}
@end
