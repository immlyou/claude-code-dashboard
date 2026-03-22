import Foundation

struct WidgetData: Codable {
    var activeSessions: Int = 0
    var todayMessages: Int = 0
    var todayTokens: Int = 0
    var todayCost: Double = 0
    var monthCost: Double = 0
    var totalCost: Double = 0
    var plan: String = ""
    var userName: String = ""
    var cacheHitRate: Int = 0
    var avgTokensPerMsg: Int = 0
    var timestamp: Double = 0

    static let placeholder = WidgetData()

    static func load() -> WidgetData {
        do {
            let homeDir = NSHomeDirectory()
            let filePath = "\(homeDir)/.claude/widget-data.json"
            let url = URL(fileURLWithPath: filePath)
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            return try decoder.decode(WidgetData.self, from: data)
        } catch {
            return .placeholder
        }
    }

    var formattedTokens: String {
        if todayTokens >= 1_000_000 { return String(format: "%.1fM", Double(todayTokens) / 1_000_000) }
        if todayTokens >= 1_000 { return String(format: "%.1fK", Double(todayTokens) / 1_000) }
        return "\(todayTokens)"
    }

    var formattedTodayCost: String { String(format: "$%.2f", todayCost) }
    var formattedMonthCost: String { String(format: "$%.2f", monthCost) }
    var formattedTotalCost: String { String(format: "$%.2f", totalCost) }

    var lastUpdated: String {
        guard timestamp > 0 else { return "—" }
        let ts = Date(timeIntervalSince1970: timestamp / 1000)
        let diff = Date().timeIntervalSince(ts)
        if diff < 60 { return "just now" }
        if diff < 3600 { return "\(Int(diff / 60))m ago" }
        return "\(Int(diff / 3600))h ago"
    }
}
