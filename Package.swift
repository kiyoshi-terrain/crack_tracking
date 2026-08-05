// swift-tools-version: 5.9
import PackageDescription

// CrackCore は ARKit / UIKit に依存しない純粋な計測ロジック層です。
// iOS アプリからも、macOS 上の CI からも同じコードをテストできます。
let package = Package(
    name: "CrackCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "CrackCore", targets: ["CrackCore"]),
    ],
    targets: [
        .target(
            name: "CrackCore",
            path: "Sources/CrackCore"
        ),
        .testTarget(
            name: "CrackCoreTests",
            dependencies: ["CrackCore"],
            path: "Tests/CrackCoreTests"
        ),
    ]
)
