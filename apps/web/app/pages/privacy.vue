<script setup lang="ts">
/* global useHead */
useHead({
  title: 'プライバシーポリシー — AstarScan',
})
</script>

<template>
  <main class="privacy">
    <article class="privacy__content">
      <h1>プライバシーポリシー</h1>

      <section>
        <h2>データ処理について</h2>
        <p>
          AstarScan は<strong>全ての処理をお使いの端末内で完結</strong>します。
          撮影した画像、生成された PDF、OCR で認識されたテキストは、
          外部サーバーに送信されることは一切ありません。
        </p>
      </section>

      <section>
        <h2>カメラアクセス</h2>
        <p>
          書類の撮影にはカメラへのアクセス許可が必要です。
          カメラ映像はリアルタイム処理のみに使用され、
          録画・保存・送信されることはありません。
        </p>
      </section>

      <section>
        <h2>ローカルストレージ</h2>
        <p>
          撮影したページの画像は、ブラウザの IndexedDB に一時保存されます。
          これはブラウザを閉じてもセッションを復元するためです。 PDF
          を出力すると自動的に削除されます。
        </p>
        <p>
          IndexedDB のデータはブラウザ/OS の暗号化に従います。 AstarScan
          独自の暗号化は現時点では施していません。
        </p>
      </section>

      <section>
        <h2>AI モデル</h2>
        <p>
          書類検出 (DocAligner) および文字認識 (NDLOCR-Lite) の AI モデルは、
          初回使用時にダウンロードされ、ブラウザの IndexedDB
          にキャッシュされます。
          モデルの推論は全てお使いの端末上で実行されます。
        </p>
      </section>

      <section>
        <h2>統計情報の送信</h2>
        <p>
          現時点では、匿名統計情報の送信機能は実装されていません。
          将来的にオプトイン方式で導入する場合は、明示的にご同意をいただいた上で、
          数値データ（成功率、処理時間等）のみを送信します。
          画像データは送信されません。
        </p>
      </section>

      <section>
        <h2>オープンソース</h2>
        <p>
          AstarScan は MIT ライセンスのオープンソースソフトウェアです。
          ソースコードは
          <a
            href="https://github.com/AstarWorks/AstarScan"
            target="_blank"
            rel="noopener"
            >GitHub</a
          >
          で公開されています。
        </p>
      </section>

      <section>
        <h2>NDLOCR-Lite 帰属表示</h2>
        <p>
          文字認識機能は NDLOCR-Lite Web AI (CC BY 4.0) を使用しています。<br />
          帰属: 国立国会図書館 (NDLOCR-Lite) / Yuta Hashimoto (ndlocrlite-web) /
          Katsuhiro Ogata (ndlocr-lite-web-ai)
        </p>
      </section>

      <footer class="privacy__footer">
        <NuxtLink to="/" class="privacy__back">スキャナーに戻る</NuxtLink>
      </footer>
    </article>
  </main>
</template>

<style scoped>
.privacy {
  min-height: 100dvh;
  padding: 2rem 1rem;
  padding-top: calc(2rem + env(safe-area-inset-top));
  padding-bottom: calc(2rem + env(safe-area-inset-bottom));
  background: #0f172a;
  color: #e2e8f0;
  font-family:
    'Hiragino Sans', 'Hiragino Kaku Gothic ProN', system-ui, sans-serif;
}

.privacy__content {
  max-width: 40rem;
  margin: 0 auto;
}

h1 {
  font-size: 1.75rem;
  font-weight: 700;
  margin: 0 0 2rem;
  background: linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

h2 {
  font-size: 1.125rem;
  font-weight: 600;
  margin: 2rem 0 0.75rem;
  color: #f1f5f9;
}

p {
  margin: 0 0 1rem;
  line-height: 1.8;
  font-size: 0.9375rem;
  color: #cbd5e1;
}

a {
  color: #93c5fd;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.privacy__footer {
  margin-top: 3rem;
  padding-top: 1.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.privacy__back {
  display: inline-block;
  padding: 0.75rem 1.5rem;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 0.75rem;
  color: #93c5fd;
  text-decoration: none;
  font-weight: 600;
  font-size: 0.875rem;
}
</style>
