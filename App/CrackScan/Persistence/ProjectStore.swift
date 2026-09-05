import Foundation
import CrackCore

/// 案件データの保存。
///
/// 現場では機内モード・圏外での運用が普通なので、まずローカルの
/// ファイルに確実に残すことを最優先にしています。1案件 = 1フォルダ で、
/// フォルダごと共有すれば写真もモデルも一緒に持ち出せます。
///
/// ```
/// Documents/Projects/<projectID>/
///   project.json
///   Sessions/<sessionID>/Images/…
///   Sessions/<sessionID>/Depth/…
///   Sessions/<sessionID>/Meta/…
///   Sessions/<sessionID>/model.usdz
/// ```
@MainActor
final class ProjectStore: ObservableObject {

    @Published private(set) var projects: [InspectionProject] = []
    @Published var lastError: String?

    private let fileManager = FileManager.default

    var rootDirectory: URL {
        let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return documents.appendingPathComponent("Projects", isDirectory: true)
    }

    init() {
        reload()
    }

    // MARK: - パス

    func directory(for project: InspectionProject) -> URL {
        rootDirectory.appendingPathComponent(project.id.uuidString, isDirectory: true)
    }

    func directory(for session: CaptureSession, in project: InspectionProject) -> URL {
        directory(for: project)
            .appendingPathComponent("Sessions", isDirectory: true)
            .appendingPathComponent(session.id.uuidString, isDirectory: true)
    }

    func imagesDirectory(for session: CaptureSession, in project: InspectionProject) -> URL {
        directory(for: session, in: project).appendingPathComponent("Images", isDirectory: true)
    }

    // MARK: - 読み書き

    func reload() {
        do {
            try fileManager.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
            let folders = try fileManager.contentsOfDirectory(
                at: rootDirectory,
                includingPropertiesForKeys: nil
            )
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601

            var loaded: [InspectionProject] = []
            for folder in folders {
                let file = folder.appendingPathComponent("project.json")
                guard let data = try? Data(contentsOf: file) else { continue }
                guard let project = try? decoder.decode(InspectionProject.self, from: data) else {
                    // 壊れたファイルで一覧全体が出なくなるのは困るのでスキップ
                    print("[ProjectStore] 読み込めない案件: \(folder.lastPathComponent)")
                    continue
                }
                loaded.append(project)
            }
            projects = loaded.sorted { $0.updatedAt > $1.updatedAt }
        } catch {
            lastError = "案件の読み込みに失敗しました: \(error.localizedDescription)"
        }
    }

    @discardableResult
    func save(_ project: InspectionProject) -> Bool {
        var updated = project
        updated.updatedAt = Date()
        do {
            let folder = directory(for: updated)
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(updated)
            try data.write(to: folder.appendingPathComponent("project.json"), options: .atomic)

            if let index = projects.firstIndex(where: { $0.id == updated.id }) {
                projects[index] = updated
            } else {
                projects.append(updated)
            }
            projects.sort { $0.updatedAt > $1.updatedAt }
            return true
        } catch {
            lastError = "保存に失敗しました: \(error.localizedDescription)"
            return false
        }
    }

    func delete(_ project: InspectionProject) {
        do {
            try fileManager.removeItem(at: directory(for: project))
            projects.removeAll { $0.id == project.id }
        } catch {
            lastError = "削除に失敗しました: \(error.localizedDescription)"
        }
    }

    /// セッションのフォルダ（写真・深度・メタ・3D モデル）を消す。無ければ何もしない。
    func deleteSessionFiles(_ session: CaptureSession, in project: InspectionProject) {
        let url = directory(for: session, in: project)
        guard fileManager.fileExists(atPath: url.path) else { return }
        do {
            try fileManager.removeItem(at: url)
        } catch {
            lastError = "セッションのフォルダを削除できませんでした: \(error.localizedDescription)"
        }
    }

    /// 撮影セッション用のフォルダを用意する。
    func prepareSessionDirectory(session: CaptureSession, in project: InspectionProject) throws -> URL {
        let url = directory(for: session, in: project)
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// 次のひび割れ番号（C-001 形式）。
    func nextCrackLabel(in project: InspectionProject) -> String {
        let existing = project.allCracks.compactMap { crack -> Int? in
            guard crack.label.hasPrefix("C-") else { return nil }
            return Int(crack.label.dropFirst(2))
        }
        return String(format: "C-%03d", (existing.max() ?? 0) + 1)
    }

    /// 案件フォルダの合計サイズ（表示用）。
    func storageSize(of project: InspectionProject) -> Int64 {
        let folder = directory(for: project)
        guard let enumerator = fileManager.enumerator(
            at: folder,
            includingPropertiesForKeys: [.fileSizeKey]
        ) else { return 0 }

        var total: Int64 = 0
        for case let url as URL in enumerator {
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            total += Int64(size)
        }
        return total
    }
}
