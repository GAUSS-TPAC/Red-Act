// Front de l'éditeur partagé : un petit routeur sur l'URL, une page à la fois.
import "quill/dist/quill.snow.css";
import "./style.css";
import { adminPage } from "./pages/admin.ts";
import { downloadPage } from "./pages/download.ts";
import { documentsPage } from "./pages/documents.ts";
import { editorPage } from "./pages/editor.ts";
import { loginPage } from "./pages/login.ts";
import { session } from "./session.ts";

const root = document.getElementById("app")!;
let cleanup: () => void = () => {};

function navigate(path: string) {
  history.pushState(null, "", path);
  render();
}

function render() {
  cleanup();
  document.title = "Éditeur du journal";
  const path = location.pathname;
  const link = path.match(/^\/l\/([0-9a-f-]{36})$/);
  if (link) {
    cleanup = downloadPage(root, link[1]!); // visiteurs anonymes : pas de session
    return;
  }
  if (path === "/admin") {
    cleanup = adminPage(root); // jeton d'administration, pas d'identité de rédacteur
    return;
  }
  if (!session()) {
    cleanup = loginPage(root, render);
    return;
  }
  const doc = path.match(/^\/doc\/([0-9a-f-]{36})$/);
  cleanup = doc ? editorPage(root, doc[1]!, navigate) : documentsPage(root, navigate);
}

window.addEventListener("popstate", render);
render();
