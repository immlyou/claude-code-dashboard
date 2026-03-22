import SwiftUI

@main
struct ClaudeDashboardApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .defaultSize(width: 400, height: 300)
    }
}

struct ContentView: View {
    @State private var data = WidgetData.load()

    var body: some View {
        VStack(spacing: 20) {
            // Logo
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(LinearGradient(
                        colors: [Color(red: 0.49, green: 0.43, blue: 0.94),
                                 Color(red: 0.65, green: 0.58, blue: 1.0)],
                        startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 32, height: 32)
                    .overlay(Text("C").font(.system(size: 16, weight: .bold)).foregroundColor(.white))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Claude Code Dashboard")
                        .font(.headline)
                    Text("Widget Companion")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            Text("This app provides the macOS widget for Claude Code Dashboard.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Text("Add the widget from Notification Center.")
                .font(.caption)
                .foregroundStyle(.tertiary)

            Spacer()

            Button("Refresh Data") {
                data = WidgetData.load()
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(red: 0.49, green: 0.43, blue: 0.94))
        }
        .padding(30)
    }
}
