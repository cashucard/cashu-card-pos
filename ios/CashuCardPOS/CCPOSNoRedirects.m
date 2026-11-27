// The till never follows an HTTP redirect (slice 2.5, ENG-905).
//
// What it does. React Native sends every fetch of this app through one NSURLSession whose delegate is
// RCTHTTPRequestHandler. When a server answers 301, 302, 303, 307 or 308, the session asks its delegate what to do
// next. This file makes the answer "nothing": the session then hands the 3xx answer itself to JavaScript, with the
// address that was asked, and nothing is sent to the address the redirect names.
//
// Why. React Native's fetch ignores `redirect: 'error'`. Left alone, the session re-sends a 307 POST, body and all,
// to the new address before the till's own guard (guardedFetch, src/till/http.ts) can refuse the answer. A sale's
// proofs must never go to an address the merchant did not add. The guard stays as the second line.
//
// How. React Native 0.77.1 already implements this delegate method (it copies cookies and follows), so a category
// with the same method would clash with it, and which of the two runs is not defined. The method is replaced at load
// time instead: class_replaceMethod swaps it when React Native defines it and adds it when it does not, so the
// outcome is the same either way. +load runs before main(), so before React Native makes its session (a session
// asks once, when it is made, which delegate methods exist).
//
// It applies to every request the app makes through React Native's networking. That is wanted: the app talks only
// to mints and, in development, to this Mac. scripts/redirect-check.sh checks at each React Native upgrade that the
// class, the header and the session's delegate are still what this file relies on.
//
// The two aborts below are about this binary, the same at every launch; each logs one line first. They do not catch
// a future React Native that answers redirects in another class: the swap would still take on this one. Only
// scripts/redirect-check.sh catches that, at build time (its version pin and its delegate line).

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <React/RCTHTTPRequestHandler.h>

static void CCPOSRefuseRedirect(__unused id self,
                                __unused SEL _cmd,
                                __unused NSURLSession *session,
                                __unused NSURLSessionTask *task,
                                __unused NSHTTPURLResponse *response,
                                __unused NSURLRequest *request,
                                void (^completionHandler)(NSURLRequest *_Nullable))
{
  // nil: do not follow; the task ends with the 3xx answer as its answer
  completionHandler(nil);
}

@interface CCPOSNoRedirects : NSObject
@end

@implementation CCPOSNoRedirects

+ (void)load
{
  SEL sel = @selector(URLSession:task:willPerformHTTPRedirection:newRequest:completionHandler:);
  struct objc_method_description d =
      protocol_getMethodDescription(@protocol(NSURLSessionTaskDelegate), sel, NO, YES);
  if (d.types == NULL) {
    // the system no longer declares this delegate method: stop rather than run a till that follows redirects
    NSLog(@"CCPOSNoRedirects: the system does not declare the redirect delegate method, so the redirect refusal "
          @"cannot be installed. The app stops here so that no request can follow a redirect.");
    abort();
  }
  class_replaceMethod([RCTHTTPRequestHandler class], sel, (IMP)CCPOSRefuseRedirect, d.types);
  if (class_getMethodImplementation([RCTHTTPRequestHandler class], sel) != (IMP)CCPOSRefuseRedirect) {
    // the replacement did not take: stop rather than run a till that follows redirects
    NSLog(@"CCPOSNoRedirects: the redirect refusal was not installed on RCTHTTPRequestHandler. The app stops here "
          @"so that no request can follow a redirect.");
    abort();
  }
}

@end
