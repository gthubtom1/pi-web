import { currentDemoLocale } from "./locale";

/** Message for actions that need a real Pi Web server. */
export function demoOnlyMessage(): string {
  return currentDemoLocale() === "zh"
    ? "这是静态演示，此操作需要真实的 Pi Web 服务。运行 pi-web 即可完整体验。"
    : "This is a static demo, so this action needs a real Pi Web server. Run pi-web to try it for real.";
}
