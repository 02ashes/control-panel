(function (root) {
    'use strict';

    const FLAGS = ['bold', 'italic', 'underline', 'strike'];
    const COLORS = [
        ['', 'По умолчанию'], ['#93c5fd', 'Синий'], ['#86efac', 'Зелёный'],
        ['#fca5a5', 'Красный'], ['#d8b4fe', 'Фиолетовый'], ['#fde68a', 'Золотой']
    ];
    const BACKGROUNDS = [
        ['', 'Без выделения'], ['#fef3c7', 'Жёлтый'], ['#dbeafe', 'Голубой'],
        ['#dcfce7', 'Зелёный'], ['#f3e8ff', 'Лиловый']
    ];
    const clone = value => JSON.parse(JSON.stringify(value));
    function hexColor(value) {
        if (typeof value !== 'string') return undefined;
        const lower = value.trim().toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(lower)) return lower;
        if (/^#[0-9a-f]{3}$/.test(lower)) return '#' + [...lower.slice(1)].map(char => char + char).join('');
        const rgb = lower.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/);
        if (!rgb || rgb.slice(1).some(component => Number(component) > 255)) return undefined;
        return '#' + rgb.slice(1).map(component => Number(component).toString(16).padStart(2, '0')).join('');
    }

    function create(host, options = {}) {
        if (!host || host.nodeType !== 1) throw new TypeError('snippet_editor_host_required');
        const model = root.SnippetsRichText;
        if (!root.Quill || !model) throw new Error('snippet_editor_dependencies_missing');
        const Delta = root.Quill.import('delta');
        const doc = host.ownerDocument;
        const removers = [];
        let disposed = false;
        let muted = false;
        let readOnly = options.readOnly === true;
        let onChange = typeof options.onChange === 'function' ? options.onChange : null;
        let selection = { index: 0, length: 0 };
        let lastValue;
        const buttons = new Map();
        const selects = new Map();
        host.replaceChildren();
        host.classList.add('snippet-rich-editor');

        function element(tag, className, text) {
            const node = doc.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }
        const toolbar = element('div', 'snippet-rich-toolbar');
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', 'Форматирование сниппета');
        const editorHost = element('div', 'snippet-rich-content');
        const status = element('div', 'snippet-rich-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        host.append(toolbar, editorHost, status);

        function listen(node, event, handler, capture = false) {
            node.addEventListener(event, handler, capture);
            removers.push(() => node.removeEventListener(event, handler, capture));
        }
        function sanitizeDelta(delta) {
            const result = new Delta();
            for (const op of delta.ops || []) {
                if (typeof op.insert !== 'string' || !op.insert) continue;
                const attributes = {};
                for (const flag of FLAGS) if (op.attributes?.[flag] === true) attributes[flag] = true;
                for (const color of ['color', 'background']) {
                    const value = hexColor(op.attributes?.[color]);
                    if (value) attributes[color] = value;
                }
                result.insert(op.insert, Object.keys(attributes).length ? attributes : undefined);
            }
            return result;
        }
        let quill = new root.Quill(editorHost, {
            theme: null,
            readOnly,
            formats: [...FLAGS, 'color', 'background'],
            modules: {
                toolbar: false,
                history: { delay: 700, maxStack: 100, userOnly: true },
                // Clipboard sometimes routes file-only pastes through uploader;
                // keep that module present but never accept any upload/embed.
                uploader: { mimetypes: [], handler() {} },
                clipboard: { matchers: [
                    [1, (_node, delta) => sanitizeDelta(delta)],
                    ['img, video, audio, iframe, object, embed, svg, math, script, style, .ql-formula', () => new Delta()]
                ] }
            }
        });
        const contentRoot = quill.root;
        contentRoot.setAttribute('role', 'textbox');
        contentRoot.setAttribute('aria-label', 'Текст сниппета');
        contentRoot.setAttribute('aria-multiline', 'true');
        contentRoot.setAttribute('spellcheck', 'false');
        contentRoot.setAttribute('data-placeholder', 'Текст сниппета');
        // Never call Quill's semantic HTML exporter. Apart from keeping copied
        // snippets plain, this avoids GHSA-v3m3-f69x-jf25's formula/video export
        // path; those formats are also absent from this editor's registry.
        quill.clipboard.onCopy = range => {
            if (!quill) return { text: '', html: '' };
            // Ctrl+A may include Quill's mandatory final newline. It is an
            // editor sentinel, not user content; real trailing blank lines stay.
            const selected = clampRange(range);
            return { text: quill.getText(selected.index, selected.length), html: '' };
        };
        for (const event of ['dragover', 'drop']) listen(contentRoot, event, e => {
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);
        listen(contentRoot, 'paste', e => {
            if (readOnly || (e.clipboardData?.files?.length &&
                !e.clipboardData.getData('text/plain') && !e.clipboardData.getData('text/html'))) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, true);

        function canonical(value) {
            const content = typeof value?.content === 'string' ? value.content : '';
            const richText = model.normalize(value?.richText, content);
            return richText ? { content, richText } : { content };
        }
        function deltaFor(value) {
            const original = value.richText || model.fromText(value.content);
            if (!value.content.includes('\r')) return original;
            // Quill renders only LF line endings. Normalize before appending
            // its sentinel: otherwise a real trailing CR combines with that
            // sentinel as CRLF and silently removes the user's last line break.
            // lastValue retains the original bytes until an actual user edit.
            const ops = clone(original.ops);
            ops[ops.length - 1].insert = ops[ops.length - 1].insert.slice(0, -1);
            const normalized = new Delta();
            let previousCR = false;
            for (const op of ops) {
                let text = op.insert;
                if (!text) continue;
                if (previousCR && text.startsWith('\n')) text = text.slice(1);
                previousCR = op.insert.endsWith('\r');
                text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                if (text) normalized.insert(text, op.attributes);
            }
            normalized.insert('\n');
            return normalized;
        }
        function clampRange(range = selection) {
            const max = Math.max(0, quill.getLength() - 1);
            const index = Math.max(0, Math.min(range?.index || 0, max));
            return { index, length: Math.max(0, Math.min(range?.length || 0, max - index)) };
        }
        function rememberSelection() {
            const range = quill?.getSelection();
            if (range) selection = { index: range.index, length: range.length };
        }
        function restoreSelection() {
            if (!quill || disposed) return;
            selection = clampRange();
            quill.setSelection(selection.index, selection.length, 'silent');
        }
        function format(name, value) {
            if (readOnly || disposed) return;
            const scrollTop = contentRoot.scrollTop;
            restoreSelection();
            quill.history.cutoff();
            if (selection.length) quill.formatText(selection.index, selection.length, name, value, 'user');
            else quill.format(name, value, 'user');
            quill.history.cutoff();
            restoreSelection();
            contentRoot.scrollTop = scrollTop;
            updateToolbar();
        }
        function addButton(name, label, text, action, shortcut) {
            const button = element('button', 'snippet-rich-button', text);
            button.type = 'button';
            button.dataset.editorAction = name;
            button.setAttribute('aria-label', label);
            button.title = label + (shortcut ? ' (' + shortcut + ')' : '');
            if (shortcut) button.setAttribute('aria-keyshortcuts', shortcut);
            if (FLAGS.includes(name)) button.setAttribute('aria-pressed', 'false');
            listen(button, 'mousedown', event => {
                rememberSelection();
                // Clicking a toolbar button must not collapse the selected text.
                event.preventDefault();
            });
            listen(button, 'click', () => { if (!disposed && !readOnly) action(); });
            toolbar.append(button);
            buttons.set(name, button);
        }
        for (const [name, label, text, shortcut] of [
            ['bold', 'Полужирный', 'B', 'Control+b Meta+b'],
            ['italic', 'Курсив', 'I', 'Control+i Meta+i'],
            ['underline', 'Подчёркнутый', 'U', 'Control+u Meta+u'],
            ['strike', 'Зачёркнутый', 'S', 'Control+Shift+x Meta+Shift+x']
        ]) addButton(name, label, text, () => {
            const current = quill.getFormat(clampRange());
            format(name, current[name] !== true);
        }, shortcut);

        function addPalette(name, label, palette) {
            const select = element('select', 'snippet-rich-palette');
            select.dataset.editorAction = name;
            select.setAttribute('aria-label', label);
            select.title = label;
            for (const [value, text] of palette) {
                const option = element('option', '', text);
                option.value = value;
                select.append(option);
            }
            listen(select, 'mousedown', rememberSelection);
            listen(select, 'focus', rememberSelection);
            listen(select, 'change', () => {
                if (!disposed && !readOnly) format(name, select.value || false);
            });
            toolbar.append(select);
            selects.set(name, select);
        }
        addPalette('color', 'Цвет текста', COLORS);
        addPalette('background', 'Выделение цветом', BACKGROUNDS);
        addButton('clean', 'Убрать форматирование', 'Сброс', () => {
            restoreSelection();
            quill.history.cutoff();
            if (selection.length) quill.removeFormat(selection.index, selection.length, 'user');
            else for (const name of [...FLAGS, 'color', 'background']) quill.format(name, false, 'user');
            quill.history.cutoff();
            restoreSelection();
            updateToolbar();
        }, 'Control+' + String.fromCharCode(92) + ' Meta+' + String.fromCharCode(92));
        addButton('undo', 'Отменить изменение', 'Назад', () => { quill.history.undo(); rememberSelection(); updateToolbar(); }, 'Control+z Meta+z');
        addButton('redo', 'Повторить изменение', 'Вперёд', () => { quill.history.redo(); rememberSelection(); updateToolbar(); }, 'Control+Shift+z Meta+Shift+z');

        function updateToolbar() {
            if (disposed || !quill) return;
            const current = quill.getFormat(clampRange());
            for (const flag of FLAGS) buttons.get(flag).setAttribute('aria-pressed', String(current[flag] === true));
            for (const [name, select] of selects) {
                const value = hexColor(current[name]) || '';
                const custom = select.querySelector('[data-current-color]');
                custom?.remove();
                if (value && ![...select.options].some(option => option.value === value)) {
                    const option = element('option', '', 'Другой цвет');
                    option.value = value;
                    option.dataset.currentColor = 'true';
                    select.append(option);
                }
                select.value = value;
            }
            buttons.get('undo').disabled = !quill.history.stack.undo.length;
            buttons.get('redo').disabled = !quill.history.stack.redo.length;
        }
        listen(contentRoot, 'keydown', event => {
            if (readOnly || !(event.ctrlKey || event.metaKey)) return;
            const key = event.key.toLowerCase();
            if ((event.shiftKey && key === 'x') || key === '\\') {
                event.preventDefault();
                event.stopImmediatePropagation();
                rememberSelection();
                buttons.get(key === '\\' ? 'clean' : 'strike').click();
            }
        }, true);
        listen(toolbar, 'keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            restoreSelection();
        });
        const selectionChanged = range => {
            if (range) selection = { index: range.index, length: range.length };
            updateToolbar();
        };
        const textChanged = (_change, _old, source) => {
            if (muted || disposed || source !== 'user') return;
            let next;
            try {
                const delta = sanitizeDelta(quill.getContents());
                const content = model.plainText({ ops: delta.ops });
                next = canonical({ content, richText: { ops: delta.ops } });
            } catch (_) {
                // Reject an oversized/invalid edit rather than silently dropping
                // stored formatting or saving a mismatched plain-text payload.
                muted = true;
                quill.setContents(deltaFor(lastValue), 'silent');
                quill.history.clear();
                muted = false;
                restoreSelection();
                status.textContent = 'Изменение не применено: превышен допустимый размер текста или форматирования.';
                return;
            }
            const changed = JSON.stringify(next) !== JSON.stringify(lastValue);
            lastValue = next;
            status.textContent = '';
            updateToolbar();
            if (changed && onChange) onChange(clone(next));
        };
        quill.on('selection-change', selectionChanged);
        quill.on('text-change', textChanged);

        function setValue(value) {
            if (disposed) return;
            const next = canonical(value);
            if (JSON.stringify(next) === JSON.stringify(lastValue)) return;
            const focused = quill.hasFocus();
            rememberSelection();
            const scrollTop = contentRoot.scrollTop;
            const scrollLeft = contentRoot.scrollLeft;
            muted = true;
            quill.setContents(deltaFor(next), 'silent');
            quill.history.clear();
            lastValue = next;
            muted = false;
            if (focused) restoreSelection();
            contentRoot.scrollTop = scrollTop;
            contentRoot.scrollLeft = scrollLeft;
            status.textContent = '';
            updateToolbar();
        }
        function setReadOnly(value) {
            if (disposed) return;
            readOnly = value === true;
            toolbar.hidden = readOnly;
            contentRoot.setAttribute('aria-readonly', String(readOnly));
            contentRoot.setAttribute('tabindex', '0');
            host.classList.toggle('is-readonly', readOnly);
            quill.enable(!readOnly);
        }
        function destroy() {
            if (disposed) return;
            disposed = true;
            onChange = null;
            for (const remove of removers) remove();
            quill.off('selection-change', selectionChanged);
            quill.off('text-change', textChanged);
            quill.disable();
            quill.setText('', 'silent');
            quill.history.clear();
            // Quill has no public destroy method. Detach the Parchment observer
            // and per-instance listeners so a revoked workspace cannot retain
            // an active editor/history or receive later DOM selection events.
            quill.scroll.observer.disconnect();
            quill.emitter.removeAllListeners();
            quill.emitter.domListeners = {};
            quill.selection.lastNative = null;
            quill.selection.lastRange = null;
            quill.selection.savedRange = null;
            contentRoot.replaceChildren();
            toolbar.replaceChildren();
            status.textContent = '';
            host.replaceChildren();
            host.classList.remove('snippet-rich-editor', 'is-readonly');
            lastValue = { content: '' };
            selection = { index: 0, length: 0 };
            quill = null;
        }
        setValue(options);
        setReadOnly(readOnly);
        return {
            root: contentRoot,
            getValue: () => clone(lastValue),
            setValue,
            setReadOnly,
            destroy,
            focus() { if (!disposed) { contentRoot.focus({ preventScroll: true }); restoreSelection(); } }
        };
    }

    root.SnippetEditor = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
