// Standalone, nonprivate desktop content for native scrolling-capture QA.
// This app has no Kiri IPC, capture simulation, file access or permission prompts.
// Build with: swiftc -target arm64-apple-macos14.0 -framework AppKit
//   -module-cache-path <temporary-cache>
//   scripts/qa/scroll-fixture-macos.swift -o <bundle>/Contents/MacOS/NativeScrollFixture
// Package as an LSUIElement app with bundle ID io.yuxino.kiri.scroll-fixture.
// Select only the scroll view below the fixed header, excluding its scrollbar.

import AppKit

private final class TopOriginView: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
private final class FixtureDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private let scrollView = NSScrollView()
    private let textView = NSTextView()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let size = NSSize(width: 700, height: 720)
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Native Scroll Fixture — Kiri QA"
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.appearance = NSAppearance(named: .aqua)
        window.backgroundColor = .white
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()

        let content = TopOriginView(frame: NSRect(origin: .zero, size: size))
        window.contentView = content
        let label = NSTextField(labelWithString: "80 numbered blocks · Select below this bar")
        label.frame = NSRect(x: 14, y: 15, width: 410, height: 20)
        label.font = .systemFont(ofSize: 12)
        label.textColor = .labelColor
        content.addSubview(label)
        addButton("Middle", x: 434, action: #selector(goMiddle), to: content)
        addButton("Up", x: 518, action: #selector(stepUp), to: content)
        addButton("Down", x: 602, action: #selector(stepDown), to: content)

        scrollView.frame = NSRect(x: 0, y: 48, width: size.width, height: size.height - 48)
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.scrollerStyle = .overlay
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .white
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.setAccessibilityLabel("Numbered scrolling fixture")
        content.addSubview(scrollView)

        let width = scrollView.contentSize.width
        textView.frame = NSRect(x: 0, y: 0, width: width, height: 1)
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        textView.textContainerInset = NSSize(width: 16, height: 12)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.drawsBackground = true
        textView.backgroundColor = .white
        textView.textColor = .black
        textView.isContinuousSpellCheckingEnabled = false
        textView.isGrammarCheckingEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.setAccessibilityLabel("80 fixed English and Chinese numbered blocks")
        scrollView.documentView = textView

        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 20
        paragraph.maximumLineHeight = 20
        paragraph.paragraphSpacing = 0
        let lines = (1...80).map { index -> String in
            let number = String(format: "%03d", index)
            let marker = index * 104729 + 7919
            return """
            BLOCK \(number) | Sequence \(number) | Marker \(marker)
            记录 \(number)：山间小路通向远处，清风吹过窗前。核对编号 \(number)。
            Item \(number): river / lantern / meadow / compass / \(marker)
            END \(number) | Original pixels | Up, down, pause, return | \(index * 37)
            """
        }.joined(separator: "\n") + "\n"
        textView.textStorage?.setAttributedString(NSAttributedString(string: lines, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
            .foregroundColor: NSColor.black,
            .paragraphStyle: paragraph,
        ]))
        if let container = textView.textContainer, let layout = textView.layoutManager {
            layout.ensureLayout(for: container)
            textView.setFrameSize(NSSize(width: width, height: ceil(layout.usedRect(for: container).height) + 24))
        }

        let menu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "Quit Native Scroll Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu
        menu.addItem(applicationItem)
        NSApp.mainMenu = menu

        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(textView)
        goMiddle()
    }

    private func addButton(_ title: String, x: CGFloat, action: Selector, to view: NSView) {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.frame = NSRect(x: x, y: 10, width: 80, height: 30)
        view.addSubview(button)
    }

    @objc private func goMiddle() {
        let maximum = max(0, textView.bounds.height - scrollView.contentView.bounds.height)
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: floor(maximum / 2)))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    // Header controls move the real native view while keeping automation's
    // pointer indicator outside the selected pixels. Wheel/trackpad checks are
    // separate; these controls do not establish human input acceptance.
    @objc private func stepUp() { step(-200) }
    @objc private func stepDown() { step(200) }

    private func step(_ delta: CGFloat) {
        let maximum = max(0, textView.bounds.height - scrollView.contentView.bounds.height)
        let next = min(maximum, max(0, scrollView.contentView.bounds.minY + delta))
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: next))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let fixtureDelegate = FixtureDelegate()
    application.setActivationPolicy(.accessory)
    application.delegate = fixtureDelegate
    withExtendedLifetime(fixtureDelegate) {
        application.run()
    }
}
