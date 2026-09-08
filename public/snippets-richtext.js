(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SnippetsRichText = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // The storage format is intentionally smaller than a general editor Delta:
    // literal text and a fixed set of inline styles, never HTML, embeds or links.
    const MAX_CONTENT_LENGTH = 1000000;
    const MAX_OPS = 20000;
    const FLAGS = ['bold', 'italic', 'underline', 'strike'];
    const COLORS = ['color', 'background'];
    const ATTRIBUTE_NAMES = [...FLAGS, ...COLORS];
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const onlyKeys = (value, keys) => Reflect.ownKeys(value).every(key => keys.includes(key));
    function invalid() { throw new TypeError('invalid_snippet_rich_text'); }
    function checkContent(content) {
        if (typeof content !== 'string' || content.length > MAX_CONTENT_LENGTH) invalid();
    }

    function attributes(value) {
        if (!record(value) || !onlyKeys(value, ATTRIBUTE_NAMES)) invalid();
        const result = {};
        for (const name of FLAGS) {
            if (!own(value, name)) continue;
            if (value[name] !== true) invalid();
            result[name] = true;
        }
        for (const name of COLORS) {
            if (!own(value, name)) continue;
            if (typeof value[name] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[name])) invalid();
            result[name] = value[name].toLowerCase();
        }
        return Object.keys(result).length ? result : undefined;
    }

    function append(ops, insert, style) {
        if (!insert) return;
        const previous = ops[ops.length - 1];
        if (previous && JSON.stringify(previous.attributes) === JSON.stringify(style)) {
            previous.insert += insert;
        } else {
            const op = { insert };
            if (style) op.attributes = style;
            ops.push(op);
        }
    }

    function parse(delta) {
        if (!record(delta) || !onlyKeys(delta, ['ops']) || !own(delta, 'ops') ||
            !Array.isArray(delta.ops) || !delta.ops.length || delta.ops.length > MAX_OPS) invalid();
        const ops = [];
        let length = 0;
        for (const op of delta.ops) {
            if (!record(op) || !onlyKeys(op, ['insert', 'attributes']) || !own(op, 'insert') ||
                typeof op.insert !== 'string' || !op.insert.length) invalid();
            length += op.insert.length;
            if (length > MAX_CONTENT_LENGTH + 1) invalid();
            const style = own(op, 'attributes') ? attributes(op.attributes) : undefined;
            append(ops, op.insert, style);
        }
        const last = ops[ops.length - 1];
        if (!last.insert.endsWith('\n')) invalid();
        const text = ops.map(op => op.insert).join('').slice(0, -1);

        // The final newline is an editor sentinel, not user content. Styles on
        // that marker cannot affect text and must not create phantom revisions.
        last.insert = last.insert.slice(0, -1);
        if (!last.insert) ops.pop();
        append(ops, '\n');
        if (ops.length > MAX_OPS) invalid();
        return { text, delta: { ops } };
    }

    function fromText(content) {
        checkContent(content);
        return { ops: [{ insert: content + '\n' }] };
    }

    function plainText(delta) { return parse(delta).text; }

    function normalize(delta, content) {
        checkContent(content);
        if (delta === undefined) return undefined;
        const parsed = parse(delta);
        if (parsed.text !== content) invalid();
        return parsed.delta.ops.some(op => op.attributes) ? parsed.delta : undefined;
    }

    return Object.freeze({ normalize, fromText, plainText, MAX_CONTENT_LENGTH, MAX_OPS });
});
