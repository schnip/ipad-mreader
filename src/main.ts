import "./styles.css";
import { ReaderApplication } from "./reader";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Application root is missing.");

const reader = new ReaderApplication(root);
void reader.start().catch((error: unknown) => {
  console.error("mreader failed to start", error);
});
