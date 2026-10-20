// Isolated, nonprivate scrolling-capture acceptance fixture. It renders real
// WebKit text with a fixed header/footer and a separate floating timer window.
// Starts only the installed Kiri capture CLI; no injected input, capture mock,
// network or user data access. The Capture button keeps activation and launch
// together so concurrent desktop automation does not select another app.
// Build: swiftc -target arm64-apple-macos14.0 -framework AppKit -framework WebKit -module-cache-path <cache>
//   scripts/qa/scroll-chat-fixture-macos.swift -o <app>/Contents/MacOS/ScrollChatFixture
import AppKit
import WebKit

private final class FixtureWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

@MainActor
private final class Delegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var timerWindow: NSPanel!
    private var web: WKWebView!
    private var timer: Timer?
    private var seconds = 0
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = NSScreen.main else { return }
        window = FixtureWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.title = "Kiri Scroll Chat Fixture"
        window.backgroundColor = .white
        window.appearance = NSAppearance(named: .aqua)
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isReleasedWhenClosed = false
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "offset")
        web = WKWebView(frame: NSRect(origin: .zero, size: screen.frame.size), configuration: config)
        web.autoresizingMask = [.width, .height]
        window.contentView = web
        let entries = (1...60).map { i in
            let body = [
                "Scrolling capture should follow the page naturally. Stop, reverse direction, and revisit the same text without duplicate rows.",
                "山间小路通向远处，清风吹过窗前。上下滚动都应自然，内容应该完整，重复经过的段落只保留一次。",
                "A quiet paragraph with generous space. This message includes several lines, a small table, and a footer that stays in the viewport.",
                "Testing original text pixels: morning / notebook / station / compass. There is no generated random texture here."
            ][i % 4]
            let table = i % 5 == 0 ? "<table><tr><td>Item \(i)</td><td>Original pixels</td></tr><tr><td>Up / down</td><td>Stable reading</td></tr></table>" : ""
            return "<article id='entry-\(i)' style='margin-bottom:\(i % 3 == 0 ? 112 : 44)px'><small>ENTRY \(String(format: "%03d", i)) · \(i * 104729 + 7919)</small><h2>Message \(i) — A clear, continuous page</h2><p>\(body)</p>\(table)<p class='end'>END \(String(format: "%03d", i))</p></article>"
        }.joined()
        let html = """
        <!doctype html><html><meta name='viewport' content='width=device-width,initial-scale=1'>
        <style>
        *{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:#fff;color:#202124;font:17px/1.65 -apple-system,BlinkMacSystemFont,sans-serif}
        .tools{position:absolute;top:34px;left:60px;right:40px;height:48px;display:flex;gap:12px;align-items:center;font-size:13px}button{font:inherit;background:#f6f6f6;border:1px solid #ccc;padding:6px 15px;border-radius:6px;color:#222}#offset{font-variant-numeric:tabular-nums}
        #page{position:absolute;left:60px;top:110px;width:920px;height:700px;overflow:auto;background:white;border:1px solid #ddd}
        #content{padding:78px 28px 130px}article{border-bottom:1px solid #e7e7e7}small{color:#808080;font-size:12px}h2{font-size:20px;margin:16px 0 12px;font-weight:600}p{margin:12px 0}.end{font-size:12px;color:#666}table{border-collapse:collapse;width:100%;font-size:15px}td{padding:12px;border-bottom:1px solid #ddd}
        .fixed{position:absolute;left:61px;width:902px;pointer-events:none}.header{top:111px;height:54px;border-bottom:1px solid #ddd;background:#fafafa;padding:12px 28px;font-weight:600;font-size:14px}
        .footer{top:692px;height:117px;padding:36px 16px 12px;background:linear-gradient(transparent,#fff 28%,#fff)}.composer{border:1px solid #ddd;border-radius:18px;background:#fff;height:64px;padding:16px 20px;color:#888;font-size:14px}
        .note{position:absolute;left:1020px;right:30px;top:160px;font-size:14px;color:#555;line-height:1.8}
        </style>
        <div class='tools'><b>Isolated native QA</b><button onclick='window.webkit.messageHandlers.offset.postMessage({capture:true})'>Capture</button><button onclick='middle()'>Middle</button><button onclick='step(-180)'>Up</button><button onclick='step(180)'>Down</button><button onclick='step(520)'>Fast down</button><button onclick='step(-520)'>Fast up</button><span id='offset'></span></div>
        <div id='page'><div id='content'>\(entries)</div></div>
        <div class='fixed header'>Conversation · Fixed header</div><div class='fixed footer'><div class='composer'>Fixed composer · must be excluded from the scrolling body</div></div>
        <div class='note'>This full window contains only generated test text.<br>Select the conversation rectangle.<br>Scroll with the wheel, reverse direction, pause and revisit.<br>The separate floating timer must not appear in the long screenshot.</div>
        <script>
        const page=document.querySelector('#page');
        function report(){const value={top:page.scrollTop,height:page.clientHeight};document.querySelector('#offset').textContent='offset '+value.top;window.webkit.messageHandlers.offset.postMessage(value)}
        function step(delta){page.scrollBy({top:delta,behavior:'instant'})}function middle(){page.scrollTop=Math.floor((page.scrollHeight-page.clientHeight)/2);window.webkit.messageHandlers.offset.postMessage({activate:true})}
        page.addEventListener('scroll',report);middle();report();
        </script></html>
        """
        web.loadHTMLString(html, baseURL: nil)
        timerWindow = NSPanel(contentRect: NSRect(x: screen.frame.minX + 770, y: screen.frame.maxY - 280, width: 180, height: 70), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        timerWindow.title = "Separate timer obstruction"
        timerWindow.level = .floating
        timerWindow.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        timerWindow.backgroundColor = NSColor(white: 0.93, alpha: 1)
        timerWindow.ignoresMouseEvents = true
        let label = NSTextField(labelWithString: "TIMER 00:00")
        label.font = .monospacedDigitSystemFont(ofSize: 24, weight: .medium)
        label.frame = NSRect(x: 10, y: 18, width: 165, height: 36)
        timerWindow.contentView?.addSubview(label)
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { guard let self else { return }; self.seconds += 1; label.stringValue = String(format: "TIMER %02d:%02d", self.seconds / 60, self.seconds % 60) }
        }
        let menu = NSMenu(); let item = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Scroll Chat Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu; menu.addItem(item); NSApp.mainMenu = menu
        window.makeKeyAndOrderFront(nil); timerWindow.orderFrontRegardless(); NSApp.activate(ignoringOtherApps: true)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["activate"] as? Bool == true || body["capture"] as? Bool == true {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            if body["capture"] as? Bool == true {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    let process = Process()
                    process.executableURL = URL(fileURLWithPath: "/Applications/Kiri.app/Contents/MacOS/kiri")
                    process.arguments = ["--capture"]
                    try? process.run()
                }
            }
            return
        }
        guard let top = body["top"], let height = body["height"] else { return }
        print("fixture offset=\(top) viewport=\(height)"); fflush(stdout)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
MainActor.assumeIsolated {
    let app = NSApplication.shared; let delegate = Delegate()
    app.setActivationPolicy(.accessory); app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
