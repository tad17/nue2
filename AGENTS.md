# AGENTS.md — Nue source map and working notes

## Purpose

This file is a persistent source-level map of the Nue repository, prepared from the project dump
`project_dump.txt`.

Use it as a first-pass orientation before analyzing or modifying Nue internals. The goal is to avoid
repeating the same repository archaeology in future conversations.

Important distinction:

- This document describes the source represented by the supplied project dump.
- The user's locally built/installed Nue version may differ from this snapshot.
- When a behavior is discussed as a fact about the source, verify the relevant file if the local version
  or a newer source dump is available.

---

## 1. Repository architecture

The dump represents the Nue monorepo. The important packages for runtime/compiler questions are:

- `nuedom` — HTML-first DOM compiler/runtime.
- `nuekit` — site/build/server pipeline and browser bootstrap.
- `nuemark` — Markdown/content parser and renderer.
- `nue-glow` — lightweight syntax highlighter.
- `nue-edgeserver` — small HTTP server/router package.

For questions about "what Nue actually does with an HTML tag", start with `nuedom`, not with
`nuekit`.

For questions about "how an HTML file becomes the page served by Nue", trace:

    nuekit
      -> asset.parse()
      -> compiler/parser
      -> asset.components()
      -> renderHTML()
      -> renderNue()
      -> nuedom

For questions about browser-side mounting:

    nuekit/client/mount.js
      -> import component libraries
      -> /@nue/nue.js
      -> nuedom.mount()
      -> createNode()
      -> render()
      -> renderTag() / renderComponent()

---

## 2. Core Nue philosophy visible in this source

`nuedom` is explicitly described as "HTML first UI assembly".

The runtime is DOM-oriented rather than VDOM-oriented:

- AST is produced from HTML-like source.
- The runtime creates actual DOM nodes.
- Updates use direct DOM diffing (`domdiff`).
- There is no general virtual DOM tree.
- Standard browser primitives are preferred.
- Custom components are represented in the AST and resolved against a component dependency list.

The source comments in `diff.js` explicitly emphasize:

1. no VDOM overhead;
2. targeted updates;
3. keyed diffs;
4. positional fallback;
5. minimal memory;
6. raw JavaScript.

Do not explain Nue using React/Vue/Svelte terminology unless a direct comparison is specifically
requested. In particular, do not assume Vue-style refs, slots, emits, lifecycle semantics, etc.

---

## 3. Compiler pipeline

### 3.1 Tokenizer

File:

    nuedom/src/compiler/tokenizer.js

Main entry:

    tokenize(template)

The tokenizer walks the source string and recognizes:

- HTML comments;
- `<script>`;
- ordinary tags;
- `{...}` / `{{...}}` / `{{{...}}}` expressions;
- text.

Important: tokenization itself does not decide whether a tag is a native HTML element or a Nue
component.

That decision happens later in `createAST()`.

---

## 4. AST construction and the crucial `is_custom` flag

File:

    nuedom/src/compiler/ast.js

Main function:

    createAST(block, imports)

The opening tag is parsed by `parseOpeningTag()`.

The initial AST object is essentially:

    {
      tag: tagName,
      ...parsedAttributes
    }

Then Nue checks SVG and HTML5 names.

The relevant logic in this source is:

    if (SVG_TAGS contains tagName) {
      comp.svg = true
      ...
    } else if (tagName.includes('-') || !HTML5_TAGS.includes(tagName)) {
      comp.is_custom = true
    }

Therefore, in this snapshot:

- a tag containing `-` is considered custom;
- an element not present in `HTML5_TAGS` is also considered custom;
- SVG gets separate treatment.

This is broader than the Web Components definition. It means "unknown HTML" and "custom
component" are intentionally collapsed into one AST category.

This is the key fact behind the Web Components question discussed later in this file.

---

## 5. Rendering dispatch

File:

    nuedom/src/dom/node.js

Inside `createNode()` there is a central `render()` dispatcher:

    function render(_ast=ast, data=self) {
      return _ast.text || _ast.fn ? renderText(_ast, data) :
        _ast.some ? renderIf(_ast, data) :
        _ast.for ? renderLoop(_ast, data) :
        _ast.is_custom ? renderComponent(_ast, data) :
        _ast.tag ? renderTag(_ast, data) :
        createFragment()
    }

This is one of the most important pieces of the runtime.

Consequences:

- native HTML/SVG tags go to `renderTag()`;
- `is_custom` tags go to `renderComponent()`;
- therefore an unknown `<foo-bar>` does not naturally reach `document.createElement('foo-bar')`;
- it is first interpreted as a Nue component candidate.

---

## 6. Native tag rendering

`renderTag()` in `nuedom/src/dom/node.js` does:

    document.createElement(ast.tag)

or:

    document.createElementNS(..., ast.tag)

for SVG.

Then it:

- applies attributes with `setAttributes()`;
- installs event handlers;
- recursively renders children;
- handles Nue's slot mechanism for Nue components;
- returns a document fragment containing the created element.

This is exactly the behavior a Web Component needs: a browser/custom-elements-compatible element
created with its original tag name and then populated with attributes and children.

---

## 7. Nue component resolution

`renderComponent()` is the other critical path.

Simplified source flow:

    function renderComponent(ast, self) {
      const attr_data = getAttrData(ast, self)

      const fn = opts.fns && opts.fns[ast.tag]
      if (fn) return renderHTML(fn({ ...attr_data, ...self }, opts))

      const comp = findComponent(ast, self)
      if (!comp) return renderHTML(renderClientStub(ast.tag, attr_data))

      const tag = ast.mount && ast.tag != 'template'
        ? ast.tag
        : comp.is
          ? comp.tag
          : 'div'

      const block = createNode(
        { ...comp, tag, is_custom: false, is_child: true },
        attr_data,
        opts,
        createNode(ast, self, opts, parent)
      )

      ...
    }

Component lookup is:

    function findComponent(ast, self) {
      let { mount, tag } = ast
      if (mount) tag = mount.fn ? exec(mount.fn, self) : mount.val
      return opts.deps?.find(c => c != ast && tag == (c.is || c.tag))
    }

So the actual criterion for a Nue component is not "has a dash".

It is:

    Is this tag present in opts.deps (or matched through mount)?

The `is_custom` flag merely routes the AST node into the component-resolution path.

---

## 8. What happens when a Nue component is missing

The current source does not simply discard every unknown nested element.

If `renderComponent()` cannot find a component, it calls:

    renderClientStub(ast.tag, attr_data)

which produces approximately:

    <my-component nue="my-component"></my-component>

and, when attributes/data exist, an adjacent:

    <script type="application/json">...</script>

This is an important distinction from saying "Nue always deletes unknown tags".

There are, however, other places where a custom root is converted to `<div>`.

### Browser API

File:

    nuedom/src/nue.js

`mount()` begins with:

    if (ast.is_custom)
      ast = { ...ast, is_custom: false, tag: 'div' }

Therefore a custom root passed directly to `mount()` is deliberately converted to a `div`.

### Fake/server DOM render

File:

    nuedom/src/dom/render.js

`mountAST()` contains:

    const dep = opts.deps?.find(c => ast.tag == (c.is || c.tag))

    if (ast.is_custom && (!dep && !ast.mount || ast == dep)) {
      ast = Object.assign({}, ast)
      delete ast.is_custom
      ast.tag = 'div'
    }

So a custom root without a matching dependency is also normalized to `<div>` during this path.

Do not overlook this root-vs-child distinction.

---

## 9. `renderClientStub()` has an important limitation

The current implementation is:

    function renderClientStub(tag, self) {
      const json = JSON.stringify(self)
      const js = json != '{}'
        ? `<script type="application/json">${json}</script>`
        : ''
      return `<${tag} nue="${tag}"></${tag}>${js}`
    }

It does NOT reproduce:

- the original attributes;
- the original children/slot content.

Instead, the attribute-derived values are moved into JSON data.

This is suitable for Nue's client-side component bootstrap mechanism, but it is not equivalent
to preserving an arbitrary Web Component element.

This is one of the most important technical caveats for Web Component interoperability.

---

## 10. Web Components hypothesis

### Short answer

The idea is fundamentally correct, but the required change is slightly more specific than simply
"do not delete the tag".

If a tag such as:

    <my-component></my-component>

is not a Nue component, the runtime could instead treat it as an ordinary DOM element:

    document.createElement('my-component')

That would allow the browser Custom Elements machinery to upgrade it when:

    customElements.define('my-component', MyComponent)

has been registered.

This is a natural fit with Nue's DOM-first architecture.

### Why this should work

The existing `renderTag()` already does exactly the operation needed:

    document.createElement(ast.tag)

The browser supports autonomous custom elements as ordinary DOM elements.

Therefore the clean conceptual split is:

    known Nue component
        -> render as Nue component

    unknown custom tag
        -> render as normal DOM/custom element

This avoids requiring a second framework for Web Components.

### Important caveat

The current implementation does not have that split.

Today:

    tag looks custom
      -> is_custom = true
      -> renderComponent()
      -> findComponent()
      -> if missing, renderClientStub()

The minimal architectural change is therefore in `renderComponent()` or, even better, in the
definition of the custom-tag resolution policy.

A sensible rule is:

    if a matching Nue component exists:
        use Nue component machinery
    else:
        create the original tag as an ordinary DOM element

That would make unknown tags naturally interoperable with Web Components.

---

## 11. What must be preserved for Web Components

A correct fallback must preserve at least:

1. original tag name;
2. ordinary attributes;
3. children;
4. event/property handling where applicable;
5. DOM identity across updates when possible.

For example:

    <my-component foo="bar">
      <span>Hello</span>
    </my-component>

must not become merely:

    <my-component nue="my-component"></my-component>

because the Web Component would lose `foo="bar"` and its light-DOM children.

A fallback through `renderTag(ast, self)` is attractive because `renderTag()` already:

- calls `document.createElement(ast.tag)`;
- applies attributes;
- recursively renders children.

This should be investigated before inventing another rendering path.

---

## 12. Browser upgrade timing

Web Components do not require Nue to know the implementation class.

The normal browser model is:

    HTML/DOM element exists
        -> customElements.define(...)
        -> browser upgrades matching elements

or:

    customElements.define(...)
        -> later document.createElement('my-component')
        -> browser creates the upgraded custom element

Therefore an external Web Component library can theoretically be loaded independently of Nue.

However, actual behavior depends on when the library is loaded and how the component is
implemented. Do not assume that every third-party Web Component library is completely insensitive
to timing, attributes, properties, or light-DOM structure.

---

## 13. Existing Nue client bootstrap

File:

    nuekit/client/mount.js

`mountAll()` finds:

    document.querySelectorAll('[nue]')

It imports Nue component libraries from the `<meta name="libs" ...>` paths and then searches:

    deps.find(a => [a.is, a.tag].includes(name))

Only when such a dependency exists does it call Nue's `mount()`.

This is useful for Web Components because an unknown custom element can be left without a matching
Nue dependency and therefore does not need to be mounted by Nue.

The current `nue="my-component"` marker is nevertheless undesirable for a pure Web Component
fallback because it is an implementation detail of Nue's component stub protocol.

A cleaner Web Component integration should normally leave the element alone rather than manufacture
a Nue `nue` marker.

---

## 14. Server-side rendering caveat

`nuedom/src/dom/fakedom.js` is intentionally small.

Its `innerHTML` setter currently contains a TODO and treats assigned HTML as text rather than parsing
full HTML.

This matters because `renderHTML()` does:

    const frag = document.createDocumentFragment()
    frag.innerHTML = html || ''

    return frag

The fake DOM serializer later emits text-node contents as raw strings.

Therefore the current `renderClientStub()` string path works as a serialization shortcut, but it is
not evidence that the fake DOM has a full browser HTML parser.

When modifying custom-element handling, test both:

- browser DOM rendering;
- server/fake-DOM rendering.

Do not assume identical internal mechanics.

---

## 15. DHTML / page build pipeline

Important files:

    nuekit/src/render/*.js
    nuekit/client/mount.js

For ordinary HTML:

    renderHTML(asset)
      -> asset.parse()
      -> asset.components()
      -> createWrapper(...)
      -> renderNue(root, { ..., deps: comps })
      -> renderPage(...)

For DHTML:

    renderDHTML(asset)
      -> parse()
      -> components(true)
      -> createWrapper()
      -> server-side wrapper/content
      -> renderPage()
      -> compileNue(...)

The build system therefore has both:

- server-side rendering/build-time handling;
- browser-side component mounting.

A change to custom element behavior must be considered in both contexts.

---

## 16. Component library discovery

`asset.components()` in `nuekit` scans HTML assets and collects libraries.

The source distinguishes libraries and DHTML documents using parsed metadata/doctype.

A library is not simply "any HTML file".

The browser bootstrap gets library paths through:

    <meta name="libs" content="...">

and `mount.js` dynamically imports:

    /<path>.js

Each module can expose:

    { lib }

Those AST entries become `deps`.

This means `opts.deps` is the central runtime component registry.

---

## 17. Important distinction: custom tag vs custom element

Do not use these terms interchangeably in future analysis.

### Nue custom component

A tag that Nue recognizes as `is_custom` and successfully resolves against a component AST in
`opts.deps`.

It can participate in Nue's:

- component AST;
- data propagation;
- scripts;
- mount callbacks;
- slot mechanism;
- nested component rendering.

### Web Component

A browser Custom Elements element, for example:

    <my-component></my-component>

whose implementation is registered through the browser's Custom Elements API.

It should remain an actual DOM element with its original tag name.

### Unknown tag

A tag for which Nue has no component definition.

In the current architecture this is routed through the Nue component path and becomes a client stub.

A possible future architecture can distinguish:

    Nue component found
    -> Nue component

    Web Component / unknown custom element
    -> native DOM element

This distinction is the central design opportunity identified in this analysis.

---

## 18. Suggested minimal experiment

Before making a broad architectural change, create a tiny test with:

HTML:

    <my-component answer="42">
      <span>Hello</span>
    </my-component>

JavaScript:

    class MyComponent extends HTMLElement {
      connectedCallback() {
        console.log(this.getAttribute('answer'))
        console.log(this.innerHTML)
      }
    }

    customElements.define('my-component', MyComponent)

Then compare three cases:

1. current Nue behavior;
2. fallback to `renderTag()` when no Nue dependency exists;
3. a real Nue component with the same tag.

Check:

- final DOM;
- attributes;
- child nodes;
- Custom Element upgrade;
- Nue updates;
- HMR/remount behavior;
- server-generated HTML;
- hydration/mount behavior if applicable.

Do not infer success only from seeing the tag in `outerHTML`.

---

## 19. Where to investigate first for this feature

Recommended source path:

    nuedom/src/compiler/ast.js
        -> is_custom assignment

    nuedom/src/dom/node.js
        -> render()
        -> renderComponent()
        -> findComponent()
        -> renderTag()
        -> renderClientStub()

    nuedom/src/dom/render.js
        -> renderNue()
        -> mountAST()

    nuedom/src/nue.js
        -> mount()

    nuekit/client/mount.js
        -> mountAll()
        -> importComponents()

Then inspect tests around these modules before changing behavior.

The likely smallest experimental patch is in `renderComponent()`:

    find component
      -> if found: existing Nue path
      -> if absent: native/custom-element path

But the exact patch should be tested against the source's existing expectations before committing.

---

## 20. DOM diffing and custom element identity

File:

    nuedom/src/dom/diff.js

The main function is:

    domdiff(prev, next)

Behavior:

- same node -> reuse;
- missing next -> remove;
- missing prev -> append;
- text nodes -> update text;
- different node type/tag -> replace;
- otherwise update attributes and children.

Children use either:

- positional diff;
- keyed diff when the first new child has a `key` attribute.

This matters for Web Components.

If a custom element is rendered through the ordinary `renderTag()` path and its tag remains
`my-component` during updates, `domdiff()` can reuse the element instead of replacing it.

If the tag changes or the runtime converts it to `div`, the custom element is replaced and its
browser lifecycle is lost.

Therefore "preserve the original tag" is not merely cosmetic; it affects Custom Element identity
and lifecycle.

---

## 21. Attributes and event handlers

`setAttributes()` in `node.js` evaluates Nue expressions and then writes attributes.

It handles:

- data attributes;
- boolean attributes;
- classes;
- CSS variable-like values;
- normal attributes.

For a Web Component, attribute preservation is generally desirable because Custom Elements commonly
observe attributes.

However, property assignment and attribute assignment are not equivalent in Web Components.

Do not automatically translate every Nue attribute into a JS property. First preserve normal HTML
attribute semantics. Property bridging should be a separate, explicit design decision.

---

## 22. Slots

Nue's `slot` behavior in `renderTag()` is Nue component machinery.

Do not automatically assume it is equivalent to Web Components' native `<slot>` semantics.

For Web Components, native light-DOM children should normally remain children of the custom element,
and the component itself decides how `<slot>` is handled.

This is another reason the Web Component fallback should use normal DOM element rendering rather
than Nue's component replacement mechanism.

---

## 23. Root handling is special

There are three different situations and they must not be conflated:

1. ordinary nested custom-looking tag;
2. root AST rendered by `renderNue()/mountAST()`;
3. root AST passed to browser `nue.mount()`.

The source currently converts an unresolved custom root to `<div>` in the latter two paths.

A proposed Web Component integration may therefore require changing root handling separately from
nested-element handling.

---

## 24. Avoid accidental architectural changes

When modifying Nue:

- do not introduce a VDOM;
- do not add a React/Vue-like component lifecycle model;
- do not add a large dependency for Web Components;
- prefer the existing `document.createElement()` path;
- keep the AST simple;
- keep `opts.deps` as the existing component registry;
- preserve standard DOM semantics where possible.

The Web Component idea is attractive precisely because it can fit the existing architecture with
a very small conceptual change.

---

## 25. Working rule for future source analysis

Before answering a question about Nue internals:

1. Locate the relevant package.
2. Locate the AST/compiler entry.
3. Trace the runtime dispatch.
4. Trace the relevant DOM operation.
5. Check both browser and fake/server DOM paths.
6. Check `nuekit` only after understanding `nuedom`.
7. Separate "source says" from "this appears to be the intended design".
8. When proposing a change, identify the smallest existing mechanism that can implement it.
9. Check tests and call sites before assuming a local change is safe.

Do not repeat a full repository analysis if the relevant section is already established here.

---

## 26. Current conclusions from the source dump

### Conclusion A — The user's Web Component idea is technically sound

If an unresolved custom tag is rendered with the existing native `renderTag()` mechanism instead of
being converted into a Nue stub, the browser can treat it as a Custom Element.

### Conclusion B — The current fallback is not a transparent Web Component fallback

`renderClientStub()` loses the original attributes and children and adds a Nue-specific `nue`
attribute.

Therefore merely "not deleting the tag" is insufficient for transparent Web Component support.

### Conclusion C — The cleanest conceptual model is component-first resolution

The runtime can first ask:

    Is there a Nue component with this tag?

If yes, use the existing Nue component machinery.

If no, render the tag natively.

That preserves Nue components while allowing arbitrary browser-native custom elements.

### Conclusion D — Root behavior needs separate treatment

Unresolved custom roots are explicitly converted to `div` in current code paths.

A complete Web Component feature therefore needs tests for both nested and root custom elements.

### Conclusion E — The change belongs primarily in nuedom

The first implementation target should be:

    nuedom/src/dom/node.js

with supporting investigation in:

    nuedom/src/dom/render.js
    nuedom/src/nue.js
    nuekit/client/mount.js

The compiler's `is_custom` flag does not necessarily need to disappear. It can continue to mean
"this tag needs custom-resolution logic", while the resolution logic gains a native fallback.

---

## 27. User-specific Nue2 context

The user is working with Nue2 and has deliberately moved away from Web Awesome as an architectural
dependency. Do not recommend Web Awesome as the default solution.

The user has tested `oat ui` with Nue2 and found that it preserves Nue2 reactivity/flow, including
popover and dialog. `oat ui` is currently considered a beta but promising option.

The user wants Nue2 treated as Nue2, not as Vue/React/Svelte.

When giving Nue2 code examples:

- use actual Nue2 mechanisms;
- avoid invented framework APIs;
- do not use `this.refs`, Vue `ref`, React hooks, slots/emit/nextTick assumptions, etc.;
- prefer flat DOM and Web Components where they fit the architecture;
- prefer standards APIs;
- avoid unnecessary abstraction.

---

## 28. Version/source caution

The supplied dump contains, among other package metadata:

- `nuedom` 0.1.1
- `nuemark` 0.7.0
- `nuekit` 2.1.1-beta.3
- `nue-glow` 0.2.5

These are source-dump package versions, not automatically the same thing as the user's locally built
Nue executable version.

The user has separately reported a local build around:

    Nue 2.0.1-beta.3
    Bun 1.3.14

Treat those as separate facts unless the current source is verified to correspond to that build.

---

## 29. Files most worth opening first

For compiler/runtime questions:

    nuedom/src/compiler/tokenizer.js
    nuedom/src/compiler/ast.js
    nuedom/src/compiler/document.js
    nuedom/src/dom/node.js
    nuedom/src/dom/diff.js
    nuedom/src/dom/render.js
    nuedom/src/dom/fakedom.js
    nuedom/src/nue.js

For page/build questions:

    nuekit/src/render/html.js
    nuekit/src/render/head.js
    nuekit/src/system.js
    nuekit/client/mount.js
    nuekit/src/asset.js
    nuekit/src/cli.js

For content/Markdown:

    nuemark/src/parse-blocks.js
    nuemark/src/parse-inline.js
    nuemark/src/render-blocks.js
    nuemark/src/render-inline.js

For syntax highlighting:

    nue-glow/index.js

For the small HTTP server:

    nue-edgeserver/*

---

## 30. Final reminder

The most important mental model for this repository is:

    HTML source
      -> tokenizer
      -> AST
      -> custom/native classification
      -> runtime render dispatch
      -> actual DOM
      -> direct DOM diff

And for components:

    custom-looking tag
      -> lookup in opts.deps
      -> Nue component if found
      -> currently client stub if not found
      -> possible future native custom-element fallback

When discussing Web Components in future, start from this exact branch point rather than treating
the feature as an external integration problem.
