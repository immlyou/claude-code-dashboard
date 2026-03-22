import WidgetKit
import SwiftUI

// MARK: - Timeline

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> SimpleEntry {
        SimpleEntry(date: Date(), sessions: 0, messages: 0, tokens: "0", cost: "$0.00")
    }

    func getSnapshot(in context: Context, completion: @escaping (SimpleEntry) -> Void) {
        completion(makeEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SimpleEntry>) -> Void) {
        let next = Calendar.current.date(byAdding: .minute, value: 5, to: Date())!
        completion(Timeline(entries: [makeEntry()], policy: .after(next)))
    }

    private func makeEntry() -> SimpleEntry {
        let d = WidgetData.load()
        return SimpleEntry(
            date: Date(),
            sessions: d.activeSessions,
            messages: d.todayMessages,
            tokens: d.formattedTokens,
            cost: d.formattedTodayCost
        )
    }
}

struct SimpleEntry: TimelineEntry {
    let date: Date
    let sessions: Int
    let messages: Int
    let tokens: String
    let cost: String
}

// MARK: - View

struct WidgetEntryView: View {
    var entry: SimpleEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Claude")
                    .font(.system(size: 12, weight: .bold))
                Spacer()
                Circle()
                    .fill(entry.sessions > 0 ? Color.green : Color.gray)
                    .frame(width: 8, height: 8)
            }

            Spacer()

            Text("\(entry.sessions)")
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .foregroundColor(Color(red: 0.49, green: 0.43, blue: 0.94))

            Text("active sessions")
                .font(.system(size: 10))
                .foregroundColor(.secondary)

            Spacer()

            HStack {
                Text("\(entry.messages) msgs")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                Spacer()
                Text(entry.cost)
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
            }
        }
        .padding()
    }
}

// MARK: - Widget

@main
struct ClaudeDashboardWidget: Widget {
    let kind = "ClaudeDashboardWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            if #available(macOS 14.0, *) {
                WidgetEntryView(entry: entry)
                    .containerBackground(.fill.tertiary, for: .widget)
            } else {
                WidgetEntryView(entry: entry)
                    .padding()
                    .background()
            }
        }
        .configurationDisplayName("Claude Dashboard")
        .description("Monitor active Claude Code sessions.")
        .supportedFamilies([.systemSmall])
    }
}
