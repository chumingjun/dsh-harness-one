import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import { defaultMarkdownSerializer } from 'prosemirror-markdown';
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { resolveImageSource, PLACEHOLDER_SPLIT } from './content.mjs';

const PlaceholderHighlight = Extension.create({
  name: 'schemePlaceholderHighlight',
  addStorage() { return { reviewItems: [] }; },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [new Plugin({ props: { decorations({ doc }) {
      const decorations = [];
      let headingIndex = 0;
      doc.descendants((node, position, parent) => {
        if (node.type.name === 'heading') {
          const anchor = `scheme-heading-${headingIndex++}`;
          const title = node.textContent.replace(/[*`]/g, '').trim();
          const code = title.match(/^(\d+(?:\.\d+)+)(?:[.、]?\s|$)/)?.[1] || '';
          if (storage.reviewItems.some(item => (item.sectionCode && item.sectionCode === code)
            || (item.sectionLabel && item.sectionLabel.trim() === title) || item.headingAnchor === anchor)) {
            decorations.push(Decoration.node(position, position + node.nodeSize, { class: 'scheme-review-heading' }));
          }
        }
        if (!node.isText || parent.type.name === 'codeBlock' || node.marks.some(mark => mark.type.name === 'code')) return;
        for (const match of node.text.matchAll(PLACEHOLDER_SPLIT)) {
          decorations.push(Decoration.inline(position + match.index, position + match.index + match[0].length, { class: 'scheme-placeholder-highlight' }));
        }
      });
      return DecorationSet.create(doc, decorations);
    } } })];
  },
});

const LocalImage = Image.extend({
  addStorage() {
    return { markdown: { serialize(state, node) {
      defaultMarkdownSerializer.nodes.image(state, node);
      if (node.isBlock) state.closeBlock(node);
    } } };
  },
  addNodeView() {
    return ({ node }) => {
      const source = resolveImageSource(node.attrs.src, this.options.images);
      const dom = document.createElement(source ? 'img' : 'span');
      if (source) { dom.src = source; dom.alt = node.attrs.alt || ''; }
      else { dom.textContent = `[${node.attrs.alt || '图片'}]`; dom.contentEditable = 'false'; }
      return { dom };
    };
  },
});

export const BODY_EXTENSIONS = [
  StarterKit, PlaceholderHighlight, Table, TableRow, TableHeader, TableCell,
  TaskList, TaskItem.configure({ nested: true }),
  LocalImage.configure({ allowBase64: true }),
  Link.configure({ openOnClick: false, autolink: false }),
  Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
];
