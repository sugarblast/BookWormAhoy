// The table of contents drawer: the PDF's own bookmarks as a collapsible list,
// with the section you are currently reading highlighted and kept in view.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

export function createOutlineView({ host, outline, onGo }) {
  const { tree, flat } = outline;
  const expanded = new Set();
  const rows = new Map();
  let active = null;

  // Short outlines open one level so the structure is visible at a glance;
  // long ones start collapsed and open along the path to where you are.
  if (flat.length <= 150) {
    for (const node of tree) if (node.children.length) expanded.add(node);
  }

  const list = h('ol', { class: 'toc' });
  host.replaceChildren(list);

  function visibleNodes(nodes, out = []) {
    for (const node of nodes) {
      out.push(node);
      if (node.children.length && expanded.has(node)) visibleNodes(node.children, out);
    }
    return out;
  }

  function buildRow(node) {
    const hasChildren = node.children.length > 0;
    const open = expanded.has(node);
    const isActive = node === active;
    return h(
      'li',
      null,
      h(
        'div',
        { class: 'toc-row', style: { '--depth': node.depth }, dataset: { active: String(isActive) } },
        hasChildren
          ? h(
              'button',
              {
                class: 'toc-toggle',
                type: 'button',
                'aria-expanded': String(open),
                'aria-label': `${open ? 'Collapse' : 'Expand'} ${node.title}`,
                onclick: () => toggle(node),
              },
              icon('chevronRight', 'size-4'),
            )
          : h('span', { class: 'w-6 flex-none', 'aria-hidden': 'true' }),
        h(
          'button',
          { class: 'toc-link', type: 'button', 'aria-current': isActive ? 'location' : null, onclick: () => onGo(node) },
          h('span', { class: 'toc-title' }, node.title),
          node.page != null ? h('span', { class: 'toc-page' }, node.page) : null,
        ),
      ),
    );
  }

  function render() {
    const scrollTop = host.scrollTop;
    rows.clear();
    list.replaceChildren(
      ...visibleNodes(tree).map((node) => {
        const row = buildRow(node);
        rows.set(node, row);
        return row;
      }),
    );
    host.scrollTop = scrollTop;
  }

  function toggle(node) {
    if (expanded.has(node)) expanded.delete(node);
    else expanded.add(node);
    render();
  }

  render();

  return {
    setActive(node) {
      if (node === active) return;
      active = node;
      for (let parent = node?.parent; parent; parent = parent.parent) expanded.add(parent);
      render();
      rows.get(node)?.scrollIntoView({ block: 'nearest' });
    },
    revealActive() {
      rows.get(active)?.scrollIntoView({ block: 'nearest' });
    },
  };
}
