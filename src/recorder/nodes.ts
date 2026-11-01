import type {
  FormState,
  Locator,
  NodeDescription,
  Scope,
  SerializedNode,
  ElementState,
} from "../shared/contracts/recording";
import {
  hasChecked,
  hasValue,
  isDocument,
  isElement,
  isImage,
  isParentNode,
  isSelect,
  isShadowRoot,
  isTemplate,
} from "./guards";

export class NodeRegistry {
  private readonly ids = new WeakMap<Node, string>();
  private nextId = 1;
  id(node: Node): string;
  id(node: Node | null | undefined): string | null;
  id(node: Node | null | undefined): string | null {
    if (!node) return null;
    let value = this.ids.get(node);
    if (!value) {
      value = `n${this.nextId++}`;
      this.ids.set(node, value);
    }
    return value;
  }
  safeUrl(doc: Document = document): string {
    try {
      return doc.location.href;
    } catch {
      return "";
    }
  }
  selector(node: Node | null | undefined): string | null {
    let element = isElement(node) ? node : node?.parentElement;
    if (!element) return null;
    const root = element.getRootNode();
    try {
      if (element.id) {
        const candidate = `#${CSS.escape(element.id)}`;
        if (isParentNode(root) && root.querySelectorAll(candidate).length === 1)
          return candidate;
      }
      const testId = element.getAttribute("data-testid");
      if (testId !== null) {
        const quoted = `"${testId.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ").replace(/\r/g, "\\d ")}"`;
        const candidate = `[data-testid=${quoted}]`;
        if (isParentNode(root) && root.querySelectorAll(candidate).length === 1)
          return candidate;
      }
    } catch {
      /* A stale root can invalidate a selector probe. */
    }
    const parts: string[] = [];
    while (element) {
      let part = CSS.escape(
        element.localName || element.nodeName.toLowerCase(),
      );
      const parent: HTMLElement | null = element.parentElement;
      const container: Node | null = parent || element.parentNode;
      const currentName = element.localName;
      if (isParentNode(container) && container.children) {
        const siblings = Array.from(container.children).filter(
          (sibling) => sibling.localName === currentName,
        );
        if (siblings.length > 1)
          part += `:nth-of-type(${siblings.indexOf(element) + 1})`;
      }
      parts.unshift(part);
      element = parent;
    }
    return parts.join(" > ");
  }
  shadowPath(node: Node | null | undefined): (string | null)[] {
    const path: (string | null)[] = [];
    let root = node?.getRootNode();
    while (isShadowRoot(root)) {
      path.unshift(this.selector(root.host));
      root = root.host.getRootNode();
    }
    return path;
  }
  scope(node: Node | null | undefined): Scope {
    const doc = isDocument(node) ? node : node?.ownerDocument || document;
    const framePath: Scope["framePath"] = [],
      frameContexts: Scope["frameContexts"] = [];
    try {
      let win: Window | null = doc.defaultView;
      while (win && win !== window && win.frameElement) {
        const frame = win.frameElement,
          selector = this.selector(frame);
        framePath.unshift(selector);
        frameContexts.unshift({
          selector,
          nodeId: this.id(frame),
          shadowPath: this.shadowPath(frame),
        });
        win = win.parent;
      }
    } catch {
      /* Navigation may detach a frame during event delivery. */
    }
    return {
      framePath,
      frameContexts,
      frameUrl: this.safeUrl(doc),
      shadowPath: this.shadowPath(node),
      rootId: this.id(node?.getRootNode() || doc),
    };
  }
  attributes(element: Element): Record<string, string> {
    return Object.fromEntries(
      Array.from(element.attributes, (a) => [a.name, a.value]),
    );
  }
  locators(element: Element, selector: string | null): Locator[] {
    const candidates: Locator[] = [];
    const testId = element.getAttribute("data-testid");
    if (testId !== null) candidates.push({ strategy: "testId", value: testId });
    if (element.id) candidates.push({ strategy: "id", value: element.id });
    // Labels is a DOM collection only on labelable HTML elements.
    const labels =
      "labels" in element &&
      element.labels &&
      typeof element.labels === "object" &&
      Symbol.iterator in element.labels
        ? Array.from(element.labels as NodeListOf<HTMLLabelElement>, (label) =>
            (label.textContent || "").trim(),
          ).filter(Boolean)
        : [];
    for (const label of labels)
      candidates.push({ strategy: "label", value: label });
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) candidates.push({ strategy: "label", value: ariaLabel });
    const placeholder = element.getAttribute("placeholder");
    if (placeholder)
      candidates.push({ strategy: "placeholder", value: placeholder });
    const roles: Record<string, string | undefined> = {
      button: "button",
      a: element.hasAttribute("href") ? "link" : undefined,
      select: "combobox",
      textarea: "textbox",
    };
    const role = element.getAttribute("role") || roles[element.localName],
      text = (element.textContent || "").trim();
    if (role)
      candidates.push({
        strategy: "role",
        value: role,
        name: ariaLabel || text || labels[0] || "",
      });
    if (text) candidates.push({ strategy: "text", value: text });
    if (selector) candidates.push({ strategy: "css", value: selector });
    return candidates;
  }
  describe(node: Node | null | undefined): NodeDescription | null {
    if (!node) return null;
    const element = isElement(node) ? node : node.parentElement,
      selector = this.selector(node);
    const result: NodeDescription = {
      nodeId: this.id(node),
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      selector,
      scope: this.scope(node),
    };
    if (element)
      Object.assign(result, {
        tagName: element.localName,
        text: element.textContent || "",
        attributes: this.attributes(element),
        locators: this.locators(element, selector),
      });
    return result;
  }
  serialize(node: Node): SerializedNode {
    const base = { nodeId: this.id(node), nodeName: node.nodeName };
    let result: SerializedNode;
    if (isElement(node)) {
      result = {
        ...base,
        nodeType: 1,
        attributes: this.attributes(node),
        namespaceURI: node.namespaceURI,
      };
      if (isImage(node) && node.currentSrc) result.currentSrc = node.currentSrc;
      if (["input", "textarea", "select"].includes(node.localName)) {
        const state: ElementState = {};
        if (hasValue(node)) state.value = node.value;
        if (hasChecked(node)) state.checked = node.checked;
        if (isSelect(node))
          state.selectedValues = Array.from(
            node.selectedOptions,
            (option) => option.value,
          );
        result.state = state;
      }
      if (isTemplate(node))
        result.templateContent = this.serialize(node.content);
      if (node.shadowRoot) result.shadowRoot = this.serialize(node.shadowRoot);
    } else if (
      node.nodeType === 3 ||
      node.nodeType === 4 ||
      node.nodeType === 8
    )
      result = { ...base, nodeType: node.nodeType, text: node.nodeValue };
    else if (
      node.nodeType === 10 &&
      "name" in node &&
      "publicId" in node &&
      "systemId" in node
    ) {
      result = {
        ...base,
        nodeType: 10,
        name: String(node.name),
        publicId: String(node.publicId),
        systemId: String(node.systemId),
      };
    } else if (
      node.nodeType === 9 ||
      node.nodeType === 11 ||
      node.nodeType === 2 ||
      node.nodeType === 5 ||
      node.nodeType === 6 ||
      node.nodeType === 7 ||
      node.nodeType === 12
    )
      result = { ...base, nodeType: node.nodeType };
    else throw new Error(`Unsupported DOM node type: ${node.nodeType}`);
    if (node.childNodes.length)
      result.children = Array.from(node.childNodes, (child) =>
        this.serialize(child),
      );
    return result;
  }
  form(element: Element): FormState {
    const result: FormState = {
      nodeId: this.id(element),
      selector: this.selector(element),
      scope: this.scope(element),
      tagName: element.localName,
      name: element.getAttribute("name"),
      type: element.getAttribute("type"),
    };
    if (hasValue(element)) result.value = element.value;
    if (hasChecked(element)) result.checked = element.checked;
    if (isSelect(element)) {
      result.selectedIndex = element.selectedIndex;
      result.selectedValues = Array.from(
        element.selectedOptions,
        (option) => option.value,
      );
    }
    if ("isContentEditable" in element && element.isContentEditable === true)
      result.text = element.textContent;
    if (
      "files" in element &&
      element.files &&
      typeof element.files === "object" &&
      Symbol.iterator in element.files
    )
      result.files = Array.from(element.files as FileList, (file) => ({
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      }));
    return result;
  }
  forms(root: ParentNode): FormState[] {
    return Array.from(
      root.querySelectorAll("input, textarea, select, [contenteditable]"),
      (element) => this.form(element),
    );
  }
}
