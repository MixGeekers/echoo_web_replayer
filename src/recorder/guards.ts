/** Structural DOM guards also work across same-origin iframe realms. */
export function isNode(value: EventTarget | null | undefined): value is Node {
  return !!value && "nodeType" in value && typeof value.nodeType === "number";
}
export function isElement(node: Node | null | undefined): node is Element {
  return node?.nodeType === 1;
}
export function isDocument(node: Node | null | undefined): node is Document {
  return node?.nodeType === 9;
}
export function isShadowRoot(
  node: Node | null | undefined,
): node is ShadowRoot {
  return node?.nodeType === 11 && "host" in node;
}
export function isParentNode(
  node: Node | null | undefined,
): node is Node & ParentNode {
  return !!node && "querySelectorAll" in node;
}
export function isFrame(
  element: Element,
): element is HTMLIFrameElement | HTMLFrameElement {
  return (
    (element.localName === "iframe" || element.localName === "frame") &&
    "contentDocument" in element
  );
}
export function isImage(element: Element): element is HTMLImageElement {
  return element.localName === "img" && "currentSrc" in element;
}
export function isSelect(element: Element): element is HTMLSelectElement {
  return element.localName === "select" && "selectedOptions" in element;
}
export function isTemplate(element: Element): element is HTMLTemplateElement {
  return element.localName === "template" && "content" in element;
}
export function hasValue(
  element: Element,
): element is Element & { value: string | number } {
  return (
    "value" in element &&
    (typeof element.value === "string" || typeof element.value === "number")
  );
}
export function hasChecked(
  element: Element,
): element is Element & { checked: boolean } {
  return "checked" in element && typeof element.checked === "boolean";
}
export function isForm(element: Element): element is HTMLFormElement {
  return element.localName === "form" && "elements" in element;
}
