#import <AppKit/AppKit.h>
#import <ServiceManagement/ServiceManagement.h>
#import <CoreServices/CoreServices.h>
#include <stdbool.h>

// A bare development/test binary must never register itself as the real app.
static bool kiri_startup_supported(void) {
    NSBundle *bundle = NSBundle.mainBundle;
    return [bundle.bundleURL.pathExtension isEqualToString:@"app"]
        && [bundle.bundleIdentifier isEqualToString:@"io.yuxino.kiri"];
}

// Keep native SMAppService status values; -1 is unavailable and -2 is failure.
int kiri_startup_status(void) {
    @autoreleasepool {
        if (!kiri_startup_supported()) return -1;
        return (int)SMAppService.mainAppService.status;
    }
}

int kiri_startup_set_enabled(bool enabled) {
    @autoreleasepool {
        if (!kiri_startup_supported()) return -1;
        SMAppService *service = SMAppService.mainAppService;
        SMAppServiceStatus status = service.status;
        // Respect a denial in System Settings. Only the user can approve it.
        if (enabled && (status == SMAppServiceStatusEnabled
            || status == SMAppServiceStatusRequiresApproval)) return (int)status;
        if (!enabled && status == SMAppServiceStatusNotRegistered) return (int)status;
        NSError *error = nil;
        BOOL success = enabled ? [service registerAndReturnError:&error]
                               : [service unregisterAndReturnError:&error];
        if (!success) {
            // A concurrent OS change can leave the requested state applied.
            status = service.status;
            if ((enabled && (status == SMAppServiceStatusEnabled
                || status == SMAppServiceStatusRequiresApproval))
                || (!enabled && status == SMAppServiceStatusNotRegistered)) return (int)status;
            NSLog(@"[startup] ServiceManagement operation failed: %@", error);
            return -2;
        }
        return (int)service.status;
    }
}

bool kiri_startup_open_settings(void) {
    @autoreleasepool {
        if (!kiri_startup_supported()) return false;
        [SMAppService openSystemSettingsLoginItems];
        return true;
    }
}

static bool kiri_startup_is_login_event(NSAppleEventDescriptor *event) {
    return (event.eventID == kAEOpenApplication || event.eventID == kAEReopenApplication)
        && [event paramDescriptorForKeyword:keyAEPropData].enumCodeValue == keyAELaunchedAsLogInItem;
}

bool kiri_startup_is_login_launch(void) {
    @autoreleasepool {
        // Tauri setup is called synchronously from Tao's did-finish-launching
        // callback, while AppKit is still dispatching this launch AppleEvent.
        NSAppleEventDescriptor *event = NSAppleEventManager.sharedAppleEventManager.currentAppleEvent;
        return kiri_startup_is_login_event(event);
    }
}
