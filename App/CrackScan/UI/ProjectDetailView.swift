import SwiftUI
import CrackCore

@MainActor
struct ProjectDetailView: View {
    @State private var project: InspectionProject
    @EnvironmentObject private var store: ProjectStore

    @State private var isCapturing = false
    @State private var memberName = ""
    @State private var isAskingMemberName = false
    @State private var exportItem: ExportItem?
    @State private var modelGeneration: ModelGenerationState?
    @State private var isConfirmingDeleteAll = false
    @State private var sessionToDelete: CaptureSession?

    init(project: InspectionProject) {
        _project = State(initialValue: project)
    }

    var body: some View {
        List {
            summarySection
            cracksSection
            sessionsSection
            exportSection
        }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    memberName = ""
                    isAskingMemberName = true
                } label: {
                    Label("撮影", systemImage: "camera.viewfinder")
                }
            }
        }
        .alert("部材名", isPresented: $isAskingMemberName) {
            TextField("例: 橋脚 P3 west 面", text: $memberName)
            Button("撮影開始") { isCapturing = true }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("どの部位を撮影するか記録しておくと、帳票に反映されます")
        }
        .fullScreenCover(isPresented: $isCapturing) {
            CaptureView(project: $project, memberName: memberName)
                .environmentObject(store)
        }
        .sheet(item: $exportItem) { item in
            ShareSheet(items: [item.url])
        }
        .onChange(of: project) { _, newValue in
            store.save(newValue)
        }
        .confirmationDialog(
            "計測結果をすべて削除しますか？",
            isPresented: $isConfirmingDeleteAll,
            titleVisibility: .visible
        ) {
            Button("\(project.allCracks.count) 本を削除", role: .destructive) { deleteAllCracks() }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("撮影セッションと保存した写真は残ります。写真も消すにはセッションを削除してください")
        }
        .confirmationDialog(
            "撮影セッションを削除しますか？",
            isPresented: Binding(
                get: { sessionToDelete != nil },
                set: { if !$0 { sessionToDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let session = sessionToDelete {
                Button("写真 \(session.frameCount) 枚と計測 \(session.cracks.count) 本を削除", role: .destructive) {
                    deleteSession(session)
                }
            }
            Button("キャンセル", role: .cancel) { sessionToDelete = nil }
        } message: {
            Text("保存した写真・深度・3D モデルもフォルダごと消えます。元に戻せません")
        }
    }

    // MARK: - セクション

    private var summarySection: some View {
        Section {
            LabeledContent("構造物", value: project.structureName.isEmpty ? "—" : project.structureName)
            LabeledContent("点検者", value: project.inspectorName.isEmpty ? "—" : project.inspectorName)
            // 目標幅は撮影ガイドのしきい値であり、検出器が狙う幅の級でもある。
            // 案件を作った後でも変えられないと、石積みの開口（数 mm）を 0.2mm の設定で
            // 撮って「検出できません」になる
            Picker("目標幅", selection: $project.targetCrackWidthMM) {
                ForEach(project.targetWidthChoicesMM, id: \.self) { width in
                    Text(String(format: "%.2f mm", width)).tag(width)
                }
            }
            LabeledContent("ひび割れ", value: "\(project.allCracks.count) 本")

            let severe = project.allCracks.filter {
                $0.grade(using: project.gradeThresholds) == .severe
            }.count
            if severe > 0 {
                LabeledContent("要詳細調査") {
                    Text("\(severe) 本")
                        .foregroundStyle(.red)
                        .fontWeight(.semibold)
                }
            }
        } header: {
            Text("概要")
        } footer: {
            Text("目標幅は「測りたい幅の級」です。撮影ガイドはこの幅を 3px 以上で撮れる距離を案内し、検出はこの幅の 0.8〜4 倍を狙います。石積みの開口なら 1〜3 mm、コンクリートのひび割れなら 0.2〜0.3 mm が目安です。")
        }
    }

    private var cracksSection: some View {
        Section {
            if project.allCracks.isEmpty {
                Text("まだ計測がありません")
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(project.sessions.enumerated()), id: \.element.id) { sessionIndex, session in
                ForEach(Array(session.cracks.enumerated()), id: \.element.id) { crackIndex, crack in
                    NavigationLink {
                        CrackDetailView(
                            crack: $project.sessions[sessionIndex].cracks[crackIndex],
                            thresholds: project.gradeThresholds
                        )
                    } label: {
                        CrackRow(crack: session.cracks[crackIndex], thresholds: project.gradeThresholds)
                    }
                    // 試し測りや失敗を消せないと、一覧が汚れて本番の値が埋もれる
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) {
                            deleteCrack(id: crack.id, inSession: session.id)
                        } label: {
                            Label("削除", systemImage: "trash")
                        }
                    }
                }
            }
        } header: {
            HStack {
                Text("計測結果")
                Spacer()
                if !project.allCracks.isEmpty {
                    Button(role: .destructive) {
                        isConfirmingDeleteAll = true
                    } label: {
                        Label("すべて削除", systemImage: "trash")
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                }
            }
        } footer: {
            if !project.allCracks.isEmpty {
                Text("左にスワイプで 1 本ずつ削除できます")
            }
        }
    }

    // MARK: - 削除

    private func deleteCrack(id: UUID, inSession sessionID: UUID) {
        guard let sessionIndex = project.sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        project.sessions[sessionIndex].cracks.removeAll { $0.id == id }
    }

    private func deleteAllCracks() {
        for index in project.sessions.indices {
            project.sessions[index].cracks = []
        }
    }

    /// セッションを写真・深度・モデルのフォルダごと消す。
    private func deleteSession(_ session: CaptureSession) {
        store.deleteSessionFiles(session, in: project)
        project.sessions.removeAll { $0.id == session.id }
        sessionToDelete = nil
    }

    private var sessionsSection: some View {
        Section("撮影セッション") {
            if project.sessions.isEmpty {
                Text("まだ撮影がありません")
                    .foregroundStyle(.secondary)
            }
            ForEach(project.sessions) { session in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(session.memberName.isEmpty ? "（部材名なし）" : session.memberName)
                            .font(.subheadline)
                        Spacer()
                        Text(session.startedAt, style: .date)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    HStack(spacing: 12) {
                        Text("\(session.frameCount) 枚")
                        Text("計測 \(session.cracks.count) 本")
                        if session.modelRelativePath != nil {
                            Label("3Dモデル", systemImage: "cube")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)

                    modelButton(for: session)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        sessionToDelete = session
                    } label: {
                        Label("削除", systemImage: "trash")
                    }
                }
            }
        }
    }

    /// 3D モデル生成は数分かかるので、案件画面から明示的に実行する。
    @ViewBuilder
    private func modelButton(for session: CaptureSession) -> some View {
        if session.modelRelativePath == nil, session.frameCount >= 10 {
            if let state = modelGeneration, state.sessionID == session.id {
                ProgressView(value: state.progress) {
                    Text("3D モデルを生成中… \(Int(state.progress * 100))%")
                        .font(.caption)
                }
            } else {
                Button {
                    generateModel(for: session)
                } label: {
                    Label("3D モデルを生成", systemImage: "cube.transparent")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .disabled(modelGeneration != nil)
            }
        } else if session.frameCount < 10 {
            Text("3D モデルの生成には 10 枚以上の記録が必要です")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func generateModel(for session: CaptureSession) {
        guard PhotogrammetryRunner.isSupported else {
            store.lastError = "この端末は Object Capture に対応していません"
            return
        }
        let images = store.imagesDirectory(for: session, in: project)
        let output = store.directory(for: session, in: project).appendingPathComponent("model.usdz")
        modelGeneration = ModelGenerationState(sessionID: session.id, progress: 0)

        Task {
            let runner = PhotogrammetryRunner()
            do {
                try await runner.generateModel(
                    imagesDirectory: images,
                    outputURL: output
                ) { fraction in
                    Task { @MainActor in
                        modelGeneration?.progress = fraction
                    }
                }
                if let index = project.sessions.firstIndex(where: { $0.id == session.id }) {
                    project.sessions[index].modelRelativePath =
                        "Sessions/\(session.id.uuidString)/model.usdz"
                }
            } catch {
                store.lastError = error.localizedDescription
            }
            modelGeneration = nil
        }
    }

    private var exportSection: some View {
        Section("出力") {
            Button {
                exportCSV()
            } label: {
                Label("CSV を書き出す", systemImage: "tablecells")
            }
            .disabled(project.allCracks.isEmpty)

            Button {
                exportPDF()
            } label: {
                Label("点検調書 PDF を書き出す", systemImage: "doc.richtext")
            }
            .disabled(project.allCracks.isEmpty)

            LabeledContent("使用容量", value: formatBytes(store.storageSize(of: project)))
        }
    }

    // MARK: - 出力

    private func exportCSV() {
        let data = CSVExporter.makeCSV(project: project)
        write(data: data, name: "\(sanitized(project.name)).csv")
    }

    private func exportPDF() {
        let data = PDFReportRenderer(project: project, store: store).render()
        write(data: data, name: "\(sanitized(project.name))_点検調書.pdf")
    }

    private func write(data: Data, name: String) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
            exportItem = ExportItem(url: url)
        } catch {
            store.lastError = "書き出しに失敗しました: \(error.localizedDescription)"
        }
    }

    private func sanitized(_ name: String) -> String {
        name.components(separatedBy: CharacterSet(charactersIn: "/\\:*?\"<>|")).joined(separator: "_")
    }

    private func formatBytes(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

struct ExportItem: Identifiable {
    let id = UUID()
    let url: URL
}

struct ModelGenerationState {
    let sessionID: UUID
    var progress: Double
}

struct CrackRow: View {
    let crack: CrackRecord
    let thresholds: CrackGrade.Thresholds

    var body: some View {
        HStack(spacing: 12) {
            let grade = crack.grade(using: thresholds)
            let c = grade.colorComponents
            RoundedRectangle(cornerRadius: 3)
                .fill(Color(red: c.red, green: c.green, blue: c.blue))
                .frame(width: 6, height: 34)

            VStack(alignment: .leading, spacing: 2) {
                Text(crack.label)
                    .font(.subheadline.weight(.semibold))
                Text(grade.displayName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                Text(String(format: "%.2f mm", crack.reportedWidthMM))
                    .font(.headline)
                    .monospacedDigit()
                HStack(spacing: 4) {
                    if !crack.isResolutionSufficient {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                    Text(String(format: "L=%.0f mm", crack.lengthMM))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        }
    }
}

/// UIActivityViewController のラッパ。
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
