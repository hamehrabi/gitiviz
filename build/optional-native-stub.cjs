// Stub for OPTIONAL native add-ons that jsdom (and its dependencies) probe
// inside try/catch — canvas, bufferutil, utf-8-validate, supports-color.
// None of them participate in diagram rendering; jsdom's own pure-JS
// fallbacks are what the Mermaid path already uses. Resolving them to this
// empty module at build time keeps the shipped engine self-contained.
module.exports = {};
