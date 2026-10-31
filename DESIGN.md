# AstarScan — DESIGN.md

> Edge document scanner PWA のビジュアル言語。**camera-first × offline-first × 片手操作 × 現場耐性**。
> 法律事務所 (デスク) と建設現場 (屋外・手袋着用) の dual-use を想定。

## 📚 全社共通 design system

本ファイルは **product 固有の voice / inspiration anchor / Do-Don't** に特化。
**全 Astar Works product 共通の brand DNA / token / voice / approachable-saas pattern** は
[`/IdeaProjects/AstarWorks/design-system/`](../AstarWorks/design-system/) を参照:

1. [`README.md`](../AstarWorks/design-system/README.md) — dispatch
2. [`01-foundation.md`](../AstarWorks/design-system/01-foundation.md) — Brand DNA
3. [`02-tokens.md`](../AstarWorks/design-system/02-tokens.md) — color / type / radius / animation の正値
4. [`03-voice.md`](../AstarWorks/design-system/03-voice.md) — 言葉遣いフレームワーク
5. [`04-approachable-saas.md`](../AstarWorks/design-system/04-approachable-saas.md) — IT 初心者向け SaaS パターン
6. [`06-intake-framework.md`](../AstarWorks/design-system/06-intake-framework.md) — UI 生成前の質問 ritual

## Product Identity

- **Product**: AstarScan — Edge document scanner PWA (`@astarworks/scan-core` / `scan-vue` / `scan-element`)
- **Primary users**:
  - **法律事務員** (デスク環境、普段 PC、モバイル scan は机上紙束)
  - **建設現場作業員** (屋外 / 倉庫、強い自然光、軍手着用、片手のみ空き)
- **Core promise**: 「紙の山にカメラ向けてペラペラめくれば、ユニークページだけ PDF 化」
- **Tone**: 現場道具。**camera viewport が主役**、chrome (UI) は極力消える。操作フィードバックは即時・明快。
- **Scope**: PWA + `<astar-scan>` Web Component + npm library の 3 形態で同じ UX を提供

## Emotional Register

| Context | Register | 具体 |
|---|---|---|
| Camera capture (メイン) | **calm-neutral** (平時) → **confidence-boost** (ページ確定時) | 緑枠 flash、カウンター +1 の即時 feedback で「取れた」を可視化 |
| Quality warning (blur / glare) | **urgency** (短時間) | 角 2 秒までの赤 tint、panic させず「動かさないで」の事実告知 |
| Export / 完了 | **celebration** (ほのか) | 進捗 bar 満了 → tick アイコン → PDF download。効果音 / confetti 禁止 |
| Error (camera 拒否 / storage full) | **calm-neutral** | 事故風 error 演出禁止。次の action (権限再申請 / 削除) を提示 |

**禁止**:
- Camera 画面で装飾 (角飾り / ネオン frame / gradient overlay) — viewport を邪魔する
- 現場 register で長時間 urgency 継続 — 疲労源になる (2 秒以内に calm に戻す)

## Inspiration Anchors

| Priority | Brand | What to borrow |
|---|---|---|
| ★★★ Primary | **Apple Camera / Notes Scan** | Camera-first UI の defacto。chrome 最小、viewport が全画面、capture feedback の即時性、余計な mode 切替なし |
| ★★ Secondary | **Notion** — `../AstarManagement/.claude/skills/ui-review/references/inspirations/notion.md` | 撮影後のページ一覧 / 整理画面。drag 並び替え、やさしい borders、dense でない |
| ★ Tertiary | **Linear** — `../AstarManagement/.claude/skills/ui-review/references/inspirations/linear.md` | 設定画面 / embedding 統合 docs のクリーンさ |

**原則**: **capture / preview 画面 = Apple**、**整理 / export 画面 = Notion**、**設定 / docs = Linear**。

## Astar Overrides (プロジェクト固有)

### Tokens

- **shadcn**: `new-york` style (AstarFax/Management と統一)
- **Primary**: Navy `#001f42` (canonical)
- **Accent / AI Purple**: OCR 結果・信頼度スコアに `oklch(var(--ai-purple))` (`#7c3aed`)
- **Camera overlay colors**: `success` green (ページ確定)、`warning` amber (blur)、`destructive` red (permission denied)
- **Font**: システム fallback (PWA は initial download 軽量化優先、BIZTER 非必須)
- **Radius**: `0.625rem` base。capture button のみ `rounded-full` 例外

### Voice

- **現場語彙**: 「撮る」「めくる」「消す」「送る」「やりなおす」— 漢字 + 動詞
- **権限文言**: 「カメラを使います」(×「カメラへのアクセスを許可してください」) — 機械的にしない
- **エラーは事実だけ**: 「ピントが合っていません。少し離してください」「容量が不足しています。古いスキャンを削除できます」
- **OCR 結果の不確実性明示**: 「たぶん『領収書』」(purple pill) で AI の推測であることを示す

### Density Philosophy

| Screen | Inspiration | Density |
|---|---|---|
| `/scan` (camera viewport) | Apple | **Chrome ゼロ** — top に 1 行 status、bottom に capture button + counter のみ |
| `/review` (撮影ページ一覧) | Notion | 中密度、grid 2-3 column、drag 並び替え |
| `/export` | Notion × Stripe | セクション化、PDF 設定 (名前 / ページ順 / 画質) |
| `/settings` | Linear | dense 設定表、shortcut 一覧、権限 status |
| embed demo (`<astar-scan>`) | Apple | ホスト画面に溶け込む中立 chrome、host theme を尊重 |

## Do

- ✅ **Camera viewport は必ず全画面**。chrome (tab bar / header) は auto-hide
- ✅ **Capture feedback は 100ms 以内**: 緑 flash + haptic (Tauri) + counter tick
- ✅ **Tap target 56px 以上** (建設現場・軍手想定、44px では足りない)
- ✅ **片手操作ゾーン**: primary CTA は画面下 1/3、端末サイズに応じて bottom-safe-area respect
- ✅ **Offline visible indicator**: Wi-Fi なしでも動くことを top-left の雲 icon で明示
- ✅ **IndexedDB 上限警告**: 残容量を常時小さく表示、80% 超で淡く warning
- ✅ **Camera permission の段階的説明**: 初回は「なぜ必要か」を 1 文、拒否後は設定への deep-link
- ✅ **Export 前 preview**: PDF 化する前に必ず全ページ thumbnail を見せる (誤 export 防止)
- ✅ **Web Component 埋め込み時 host theme 尊重**: CSS `color-scheme` + `var(--astar-scan-*)` で host が上書き可能

## Don't

- ❌ **Camera viewport 上の装飾 / overlay / watermark** — viewport が主役、UI は透明であるべき
- ❌ **派手 capture animation** (shutter close / zoom pulse 等) — 連続撮影の邪魔
- ❌ **"AI が判定しました" を主語にする** — 結果提示のみ、AI を自慢しない (company rule)
- ❌ **オフライン状態でネガティブ表現** — 「接続がありません」ではなく「オフラインで動作中」
- ❌ **Tap 36px 以下の UI** — 現場では絶対 NG
- ❌ **camera permission を modal blocking で強制** — 穏やかな in-content CTA で誘導
- ❌ **建設現場 register に luxury 演出** — 素朴さを守る
- ❌ **Noto Sans JP / BIZTER を CDN load** — PWA initial size 膨張、システム fallback で十分

## For AI Agents / Skills

実装 / レビュー時は以下を **この順で** 読む:

1. **本ファイル** (`DESIGN.md`) — product 固有 voice / inspiration / Do-Don't
2. **`/IdeaProjects/AstarWorks/design-system/02-tokens.md`** — token の正値
3. **`/IdeaProjects/AstarWorks/design-system/04-approachable-saas.md`** — IT 苦手層パターン
4. **Apple HIG Camera pattern** (一般知識、参照 URL なし) — camera-first UX の defacto
5. **Notion inspiration** — `../AstarManagement/.claude/skills/ui-review/references/inspirations/notion.md`
6. `packages/element/` — Web Component ホスト連携の実装
7. `apps/web/` — PWA の実装パターン

### Quick Rule of Thumb

> **"Apple Camera の camera-first × Notion の整理しやすさ × 現場道具の素朴さ"** がゴール。
> 迷ったら viewport を広げ、UI を消す。装飾は敵、操作音 / haptic が主語。

### Intake silence fallback

`/IdeaProjects/AstarWorks/design-system/06-intake-framework.md` の 4 問に designer が
沈黙した場合、以下を自動採用:

- **Q1 audience**: 法律事務員 (デスク撮影、主利用者) — 建設現場は secondary
- **Q2 emotion register**: calm-neutral — camera UI は静けさ第一
- **Q3 inspiration**: Apple 優先 (camera viewport が過半の画面)
- **Q4 continuity**: 既存延長 — scan / review / export の視覚一貫性が最優先

沈黙 fallback を使った場合は納品時に `Intake: fallback (Q1=事務員 / Q2=calm / Q3=Apple / Q4=既存延長)`
と明示すること。例外: `<astar-scan>` Web Component / docs / embed example の場合は
Q1 は「外部 host 統合者 (IT 担当者)」、Q3 は「Linear」に切替。

## バージョン

- 2026-04-20: 初稿。Camera-first PWA + dual-use (法律/建設) audience を踏まえて新規作成。Intake silence fallback 記載。
