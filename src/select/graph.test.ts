import { describe, expect, it } from 'vitest';

import { importsOf, namesInClause } from './graph.js';

describe('importsOf', () => {
  it('reads every import form and what each binds', () => {
    const text = [
      "import React, { useState, type Props } from 'react'",
      "import type { Row } from './Table'",
      "import * as all from './all'",
      "import './side-effect.css'",
      "export { Button as Btn, Toast } from './Button'",
      "export * from './cells'",
      "const lazy = () => import('./Lazy')",
      "const legacy = require('./legacy')",
    ].join('\n');
    expect(importsOf(text)).toEqual([
      { names: new Set(['default', 'useState']), specifier: 'react', reexport: false },
      { names: new Set(), specifier: './Table', reexport: false },
      { names: new Set(['*']), specifier: './all', reexport: false },
      { names: new Set(['Button', 'Toast']), specifier: './Button', reexport: true },
      { names: new Set(['*']), specifier: './cells', reexport: true },
      { names: new Set(['*']), specifier: './side-effect.css', reexport: false },
      { names: new Set(['*']), specifier: './Lazy', reexport: false },
      { names: new Set(['*']), specifier: './legacy', reexport: false },
    ]);
  });

  it('binds nothing for a type import and keeps the exporter name of an alias', () => {
    expect(namesInClause('{ A as B, type C }', false)).toEqual(new Set(['A']));
    expect(namesInClause('{ A }', true)).toEqual(new Set());
    expect(namesInClause('Default, { x }', false)).toEqual(new Set(['default', 'x']));
  });
});
