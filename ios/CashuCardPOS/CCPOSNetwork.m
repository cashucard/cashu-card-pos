#import <Network/Network.h>
#import <React/RCTBridgeModule.h>

@interface CCPOSNetwork : NSObject <RCTBridgeModule>
@end

@implementation CCPOSNetwork

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(status:(RCTPromiseResolveBlock)resolve rejecter:(__unused RCTPromiseRejectBlock)reject)
{
  // A new monitor's initial state is unknown. Wait for its first update on a private serial queue.
  dispatch_queue_t queue = dispatch_queue_create("org.cashucard.pos.network-status", DISPATCH_QUEUE_SERIAL);
  __block nw_path_monitor_t monitor = nw_path_monitor_create();
  void (^finish)(NSString *) = ^(NSString *value) {
    if (!monitor) return;
    nw_path_monitor_cancel(monitor);
    monitor = nil;
    resolve(value);
  };

  nw_path_monitor_set_queue(monitor, queue);
  nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
    switch (nw_path_get_status(path)) {
      case nw_path_status_satisfied:   finish(@"online"); break;
      case nw_path_status_unsatisfied: finish(@"offline"); break;
      default:                         finish(@"unknown"); break;
    }
  });
  nw_path_monitor_start(monitor);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 750 * NSEC_PER_MSEC), queue, ^{
    finish(@"unknown");
  });
}

@end
