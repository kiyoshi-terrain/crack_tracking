import SwiftUI
import CrackCore

struct ProjectListView: View {
    @EnvironmentObject private var store: ProjectStore
    @State private var isCreating = false
    @State private var newProjectName = ""
    @State private var newStructureName = ""
    @State private var newInspectorName = ""
    @State private var newTargetWidth = 0.2

    var body: some View {
        NavigationStack {
            Group {
                if store.projects.isEmpty {
                    emptyState
                } else {
                    projectList
                }
            }
            .navigationTitle("案件")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        isCreating = true
                    } label: {
                        Label("新規案件", systemImage: "plus")
                    }
                }
            }
            .sheet(isPresented: $isCreating) {
                newProjectSheet
            }
            .alert("エラー", isPresented: Binding(
                get: { store.lastError != nil },
                set: { if !$0 { store.lastError = nil } }
            )) {
                Button("OK", role: .cancel) { store.lastError = nil }
            } message: {
                Text(store.lastError ?? "")
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("案件がありません", systemImage: "ruler")
        } description: {
            Text("右上の + から点検案件を作成してください")
        } actions: {
            Button("新規案件を作成") { isCreating = true }
                .buttonStyle(.borderedProminent)
        }
    }

    private var projectList: some View {
        List {
            ForEach(store.projects) { project in
                NavigationLink {
                    // 詳細画面は案件のコピーを @State で持ち、変更時に store へ保存する。
                    // store.projects への直接バインドは保存で updatedAt が変わるたびに
                    // onChange が再発火して無限ループになるため避けている。
                    ProjectDetailView(project: project)
                } label: {
                    ProjectRow(project: project)
                }
            }
            .onDelete { offsets in
                for index in offsets {
                    store.delete(store.projects[index])
                }
            }
        }
    }

    private var newProjectSheet: some View {
        NavigationStack {
            Form {
                Section("基本情報") {
                    TextField("案件名（例: R7 定期点検）", text: $newProjectName)
                    TextField("構造物名（例: ○○高架橋）", text: $newStructureName)
                    TextField("点検者", text: $newInspectorName)
                }
                Section {
                    Picker("目標ひび割れ幅", selection: $newTargetWidth) {
                        ForEach(InspectionProject.targetWidthPresetsMM, id: \.self) { width in
                            Text(String(format: "%.2f mm", width)).tag(width)
                        }
                    }
                } header: {
                    Text("計測設定")
                } footer: {
                    Text("「測りたい幅の級」です。この幅を 3px 以上で撮れる距離まで近づくよう撮影画面でガイドし、検出はこの幅の 0.8〜4 倍を狙います。石積みの開口なら 1〜3 mm、コンクリートのひび割れなら 0.2〜0.3 mm。後から案件画面で変えられます。")
                }
            }
            .navigationTitle("新規案件")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { isCreating = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("作成") { create() }
                        .disabled(newProjectName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func create() {
        let project = InspectionProject(
            name: newProjectName.trimmingCharacters(in: .whitespaces),
            structureName: newStructureName,
            inspectorName: newInspectorName,
            targetCrackWidthMM: newTargetWidth
        )
        store.save(project)
        newProjectName = ""
        newStructureName = ""
        newInspectorName = ""
        newTargetWidth = 0.2
        isCreating = false
    }
}

private struct ProjectRow: View {
    let project: InspectionProject

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(project.name)
                .font(.headline)
            if !project.structureName.isEmpty {
                Text(project.structureName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Label("\(project.allCracks.count)", systemImage: "ruler")
                Label("\(project.sessions.count)", systemImage: "camera")
                Text(project.updatedAt, style: .date)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}
