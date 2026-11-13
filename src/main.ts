import "./style.css";
import { CounterInputError, increment } from "./counter";

declare const __APP_VERSION__: string;

const REQUIREMENT_ID = "REQ-CNT-01";

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Required element is missing: ${selector}`);
  }

  return element;
}

const app = requireElement<HTMLDivElement>("#app");

const appVersion =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "development";

app.innerHTML = `
  <main class="page-shell">
    <header class="hero">
      <div class="hero-copy">
        <p class="eyebrow">SPEC LOOP <span aria-hidden="true">/</span> 第一轮演示</p>
        <h1>需求驱动的计数器</h1>
        <p class="lede">从文档到页面，用一个小而清晰的交互验证完整交付链路。</p>
      </div>
      <dl class="meta-card" aria-label="构建信息">
        <div>
          <dt>需求 ID</dt>
          <dd>${REQUIREMENT_ID}</dd>
        </div>
        <div>
          <dt>页面版本</dt>
          <dd id="app-version"></dd>
        </div>
      </dl>
    </header>

    <div class="content-grid">
      <section class="counter-card" aria-labelledby="counter-heading">
        <div class="section-heading">
          <div>
            <p class="section-kicker">CURRENT VALUE</p>
            <h2 id="counter-heading">当前计数</h2>
          </div>
          <span class="live-indicator"><span aria-hidden="true"></span>就绪</span>
        </div>

        <output
          id="counter-value"
          class="counter-value"
          aria-live="polite"
          aria-atomic="true"
        >0</output>

        <form id="counter-form" class="counter-form" novalidate>
          <label for="step-input">每次增加的步长</label>
          <div class="input-row">
            <input
              id="step-input"
              name="step"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              value="1"
              aria-describedby="step-hint error-message"
            />
            <button class="button button-primary" type="submit">增加</button>
          </div>
          <p id="step-hint" class="field-hint">请输入安全范围内的整数，支持正负步长。</p>
        </form>

        <button id="reset-button" class="button button-secondary" type="button">
          重置计数
        </button>
      </section>

      <aside class="side-column" aria-label="需求行为与错误提示">
        <section class="info-card" aria-labelledby="behavior-heading">
          <div class="section-heading compact">
            <div>
              <p class="section-kicker">BEHAVIOR</p>
              <h2 id="behavior-heading">本页行为</h2>
            </div>
            <span class="requirement-tag">${REQUIREMENT_ID}</span>
          </div>
          <ul class="behavior-list">
            <li><span>01</span><p>页面打开时，计数从 <strong>0</strong> 开始。</p></li>
            <li><span>02</span><p>输入整数步长，点击“增加”累计计数。</p></li>
            <li><span>03</span><p>点击“重置”归零，并保留当前步长。</p></li>
          </ul>
        </section>

        <section
          id="error-panel"
          class="error-card"
          role="alert"
          aria-live="assertive"
          hidden
        >
          <p class="error-label">STEP INPUT ERROR</p>
          <h2>步长输入有误</h2>
          <p id="error-message">请输入整数步长后重试。</p>
          <p class="error-detail">当前计数没有改变。</p>
          <button id="error-recovery" class="text-button" type="button">
            返回修改步长
          </button>
        </section>
      </aside>
    </div>

    <footer class="page-footer">
      <span>需求文档是唯一事实来源</span>
      <span aria-hidden="true">•</span>
      <span>所有计算都发生在当前浏览器中</span>
    </footer>
  </main>
`;

const form = requireElement<HTMLFormElement>("#counter-form");
const stepInput = requireElement<HTMLInputElement>("#step-input");
const counterValue = requireElement<HTMLOutputElement>("#counter-value");
const appVersionElement = requireElement<HTMLElement>("#app-version");
const resetButton = requireElement<HTMLButtonElement>("#reset-button");
const errorPanel = requireElement<HTMLElement>("#error-panel");
const errorMessage = requireElement<HTMLParagraphElement>("#error-message");
const errorRecovery = requireElement<HTMLButtonElement>("#error-recovery");

let current = 0;

appVersionElement.textContent = appVersion;

function renderCounter() {
  counterValue.textContent = String(current);
}

function clearError() {
  errorPanel.hidden = true;
  stepInput.removeAttribute("aria-invalid");
}

function describeInputError(error: CounterInputError): string {
  switch (error.code) {
    case "EMPTY_STEP":
      return "步长不能为空。请填写整数步长后重试。";
    case "INVALID_STEP":
      return "步长必须是完整整数，请修改后重试。";
    case "OUT_OF_RANGE":
      return "步长或计算结果超出安全整数范围，请使用更小的整数。";
  }
}

function showInputError(error: CounterInputError) {
  errorMessage.textContent = describeInputError(error);
  errorPanel.hidden = false;
  stepInput.setAttribute("aria-invalid", "true");
  stepInput.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();

  try {
    current = increment(current, stepInput.value);
    renderCounter();
    clearError();
  } catch (error) {
    if (error instanceof CounterInputError) {
      showInputError(error);
      return;
    }

    throw error;
  }
});

resetButton.addEventListener("click", () => {
  current = 0;
  renderCounter();
  clearError();
  stepInput.focus();
});

errorRecovery.addEventListener("click", () => {
  stepInput.focus();
  stepInput.select();
});
