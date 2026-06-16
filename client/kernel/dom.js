/**
 * client/kernel/dom.js — tiny DOM helpers.
 * Framework-free: document.createElement, appendChild, etc.
 */

/**
 * Create an element with properties and children.
 * @param {string} tag
 * @param {object} props — attributes and properties to set
 * @param {(string|Node)[]} children
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const elem = document.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (key === 'className') {
      elem.className = val;
    } else if (key === 'textContent') {
      elem.textContent = val;
    } else if (key.startsWith('on')) {
      const event = key.slice(2).toLowerCase();
      elem.addEventListener(event, val);
    } else {
      elem.setAttribute(key, val);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') {
      elem.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      elem.appendChild(child);
    }
  }
  return elem;
}

/**
 * Remove all children from a node.
 * @param {HTMLElement} node
 */
export function clear(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}
