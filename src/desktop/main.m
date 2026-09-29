#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <unistd.h>

static NSString *const DashboardURL = @"http://127.0.0.1:3000/";
static NSString *const HealthURL = @"http://127.0.0.1:3000/api/state";
static NSString *const ServiceName = @"me.askhenry.jev-trading-bot";

@interface TradingBotApp : NSObject <NSApplicationDelegate, WKNavigationDelegate>
@property (strong) NSWindow *window;
@property (strong) WKWebView *webView;
@property BOOL startedService;
- (void)connectWithAttempts:(NSInteger)attempts;
@end

@implementation TradingBotApp

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    NSRect frame = NSMakeRect(0, 0, 1160, 820);
    self.window = [[NSWindow alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"JEV Trading Bot";
    self.window.minSize = NSMakeSize(540, 540);
    [self.window center];

    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.navigationDelegate = self;
    self.window.contentView = self.webView;
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [self showMessage:@"Connecting to the local paper trading dashboard..."];
    [self connectWithAttempts:10];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (void)connectWithAttempts:(NSInteger)attempts {
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:HealthURL]];
    request.timeoutInterval = 1.5;
    __weak typeof(self) weakSelf = self;
    [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            TradingBotApp *strongSelf = weakSelf;
            if (!strongSelf) return;
            if ([(NSHTTPURLResponse *)response statusCode] == 200) {
                [strongSelf.webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:DashboardURL]]];
                return;
            }
            if (!strongSelf.startedService) {
                strongSelf.startedService = YES;
                [strongSelf startService];
            }
            if (attempts > 1) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                    [strongSelf connectWithAttempts:attempts - 1];
                });
            } else {
                [strongSelf showMessage:@"The local dashboard is unavailable. Check the JEV Trading Bot login service, then reopen this app."];
            }
        });
    }] resume];
}

- (void)startService {
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/launchctl"];
    task.arguments = @[@"kickstart", [NSString stringWithFormat:@"gui/%u/%@", getuid(), ServiceName]];
    task.standardOutput = [NSPipe pipe];
    task.standardError = [NSPipe pipe];
    @try { [task launchAndReturnError:nil]; } @catch (NSException *exception) { }
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self showMessage:@"The dashboard connection was lost. Reconnecting..."];
    [self connectWithAttempts:10];
}

- (void)showMessage:(NSString *)message {
    NSString *safe = [[message stringByReplacingOccurrencesOfString:@"&" withString:@"&amp;"]
        stringByReplacingOccurrencesOfString:@"<" withString:@"&lt;"];
    NSString *html = [NSString stringWithFormat:@"<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body style='margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f9f7;color:#26362b;font:16px -apple-system,BlinkMacSystemFont,sans-serif'><div style='max-width:440px;padding:32px;text-align:center'><h1 style='font-size:22px'>JEV Trading Bot</h1><p>%@</p></div></body></html>", safe];
    [self.webView loadHTMLString:html baseURL:nil];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        TradingBotApp *delegate = [[TradingBotApp alloc] init];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
