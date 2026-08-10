/**
 * The in-page half of variants: apply, then verify (variants spec §7, §9, D22).
 *
 * Both functions here run **inside the page**, so each is written as one self-contained function
 * closing over nothing — Playwright serializes it to source and evaluates it in the page context,
 * exactly as `runner/capture.ts#collectDom` is. Everything they need arrives through their single
 * JSON argument. The type imports below are erased at compile time and never appear in the emitted
 * function.
 *
 * ## Why apply and verify are one call
 *
 * D22 chose apply-once over a `MutationObserver` that re-applies, because fighting a reconciler
 * risks a page that never settles, and settling is the determinism the runner exists to sell. The
 * failure that choice creates is specific and dangerous: an app that re-renders between mutation
 * and capture silently reverts the variant, producing a screenshot of the **unvaried** UI labelled
 * as a proposal — a wrong answer that looks exactly like a right one.
 *
 * So application is followed by a verification pass that re-queries every rule's effect and reports
 * `applied`, `reverted` or `unmatched`. It runs in this same call, immediately before the runner
 * takes the screenshot, to leave the smallest possible window for a re-render to intervene (§9).
 * The pass is one assertion per changed element; it converts a silent wrong answer into a loud one.
 *
 * ## What "still present" means, per verb
 *
 * Verification never re-reads the *authored* value: it reads back what the browser stored at
 * application time and compares against that. A value the browser normalised (`RED` → `red`) or
 * rejected outright is then judged on what actually landed, not on what was asked for — a rejected
 * declaration reports as a change that is not present, which is the truth.
 *
 * | verb | still present when |
 * |---|---|
 * | `style` | the element is connected and every accepted declaration still reads back |
 * | `text` | the element is connected and still carries the text that was set |
 * | `hide` | the element is connected and still carries `display: none` |
 * | `order` | the element is connected and still sits where the rule put it, relative to its siblings |
 * | `clone` | every inserted copy is connected and still inside the container it was inserted into |
 *
 * A framework re-render usually replaces the DOM node rather than mutating it, so the recorded
 * element goes `isConnected === false` and every verb catches it. A reconciler that keeps the node
 * and resets its properties is caught by the value comparison.
 */

import type { VariantVerb } from '../variant/index.js';
import type {
  AttributedElement,
  CloneExtractArgs,
  CloneExtractResult,
  CloneStyleDifference,
  RuleResult,
  VariantApplyArgs,
  VariantApplyReport,
} from './types.js';

/**
 * Apply a variant to the page and verify it survived, in one pass.
 *
 * @param args every rule, already resolved (see `plan.ts`) — the only value Playwright sends.
 * @param doc defaults to the page's own `document`; passed explicitly by the golden tests.
 * @param onApplied the single seam in this function: a hook run between application and
 *   verification, so a test can simulate the framework re-render D22 exists to catch at exactly the
 *   point it would happen in production. The runner never passes it — `page.evaluate` hands the
 *   function one argument.
 */
export function applyVariantInPage(
  args: VariantApplyArgs,
  doc: Document = document,
  onApplied?: () => void,
): VariantApplyReport {
  // Duplicated from `types.ts#VARIANT_ATTRS`; this function closes over nothing, and the golden
  // tests assert the two spellings agree.
  const VARIANT_ATTR = 'data-vdiff-variant';
  const RULE_ATTR = 'data-vdiff-rule';
  const VERB_ATTR = 'data-vdiff-verb';
  const STYLE_MARK = 'data-vdiff-variant-style';
  const CLONE_MARK = 'data-vdiff-clone';

  const variant = args.variant;
  const results: RuleResult[] = [];
  const attributions: AttributedElement[] = [];
  const pending: Array<{
    result: RuleResult;
    checks: Array<() => boolean>;
    onVerify?: () => void;
  }> = [];
  let stylesInjected = 0;

  /**
   * `null` means the browser could not evaluate the selector, which is a different failure from
   * "matched nothing" and must never be reported as one (§9: anything the selector layer cannot
   * evaluate is an error, not a silent no-match).
   */
  const queryAll = (root: Document | Element, selector: string): HTMLElement[] | null => {
    try {
      // SVG elements are not `HTMLElement`, but every member used below — `style`, `isConnected`,
      // `getAttribute` — is on `Element` or `ElementCSSInlineStyle`, which both carry.
      return Array.prototype.slice.call(root.querySelectorAll(selector)) as HTMLElement[];
    } catch {
      return null;
    }
  };

  /** A best-effort stable selector for an element, in the spirit of `diff/selector.ts`. */
  const describe = (el: Element): string => {
    const testId =
      el.getAttribute('data-test') ??
      el.getAttribute('data-testid') ??
      el.getAttribute('data-test-id');
    if (testId !== null && testId !== '') return '[data-test="' + testId + '"]';
    const id = el.getAttribute('id');
    if (id !== null && id !== '') return '#' + id;
    const parts: string[] = [];
    let node: Element | null = el;
    while (node !== null) {
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent === null) {
        parts.unshift(tag);
        break;
      }
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling !== null) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      let ambiguous = index > 1;
      let after = node.nextElementSibling;
      while (!ambiguous && after !== null) {
        if (after.tagName === node.tagName) ambiguous = true;
        after = after.nextElementSibling;
      }
      parts.unshift(ambiguous ? tag + ':nth-of-type(' + String(index) + ')' : tag);
      node = parent;
    }
    return parts.join('>');
  };

  /** Position among element siblings, so `before`/`after` can be checked without node identity. */
  const indexOf = (el: Element): number => {
    let index = 0;
    let sibling = el.previousElementSibling;
    while (sibling !== null) {
      index += 1;
      sibling = sibling.previousElementSibling;
    }
    return index;
  };

  /** Record `{ variant, ruleId, verb }` on the element and in the report (§7). */
  const stamp = (el: Element, ruleId: string, verb: VariantVerb): void => {
    const append = (name: string, value: string): void => {
      const current = el.getAttribute(name);
      if (current === null || current === '') {
        el.setAttribute(name, value);
        return;
      }
      if (current.split(',').indexOf(value) === -1) el.setAttribute(name, current + ',' + value);
    };
    append(VARIANT_ATTR, variant);
    append(RULE_ATTR, ruleId);
    append(VERB_ATTR, verb);
    attributions.push({ variant: variant, ruleId: ruleId, verb: verb, target: describe(el) });
  };

  /**
   * Carry a clone source's injected `<style>` into this page (§4). CSS-in-JS injects at mount time,
   * so a component cloned onto a page where it never mounted has no rules here at all.
   */
  const injectStyle = (css: string): void => {
    if (css === '') return;
    const existing = queryAll(doc, 'style') ?? [];
    for (const node of existing) {
      if ((node.textContent ?? '') === css) return;
    }
    const style = doc.createElement('style');
    style.setAttribute(STYLE_MARK, variant);
    style.textContent = css;
    const host: Element = doc.head ?? doc.documentElement;
    host.appendChild(style);
    stylesInjected += 1;
  };

  /** Parse one element out of a clone source's `outerHTML`. */
  const parseElement = (html: string): HTMLElement | null => {
    // `<template>` parses table sections and list items in the right context; a `<div>` host would
    // drop a `<tr>` on the floor. The fallback is for documents without template support.
    try {
      const template = doc.createElement('template');
      if (typeof template.content !== 'undefined') {
        template.innerHTML = html;
        const first = template.content.firstElementChild;
        if (first !== null) return first as HTMLElement;
        return null;
      }
    } catch {
      /* fall through to the host element */
    }
    const host = doc.createElement('div');
    host.innerHTML = html;
    const first = host.firstElementChild;
    return first === null ? null : (first as HTMLElement);
  };

  const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ');

  for (const rule of args.rules) {
    const result: RuleResult = {
      ruleId: rule.id,
      verb: rule.verb,
      outcome: 'unmatched',
      matched: 0,
      changed: 0,
      verified: 0,
    };
    const checks: Array<() => boolean> = [];
    results.push(result);

    /* ------------------------------------------------------------------ clone (§4, D23) */

    if (rule.verb === 'clone') {
      const clone = rule.clone;
      for (const css of clone.source.styles) injectStyle(css);

      const targets = queryAll(doc, clone.into);
      if (targets === null) {
        result.detail = "the browser could not evaluate the selector '" + clone.into + "'";
        pending.push({ result: result, checks: checks });
        continue;
      }
      result.matched = targets.length;
      const target = targets[0];
      if (target === undefined) {
        result.detail = "no element matched into: '" + clone.into + "'";
        pending.push({ result: result, checks: checks });
        continue;
      }
      const details: string[] = [];
      if (targets.length > 1) {
        details.push(
          "into: '" +
            clone.into +
            "' matched " +
            String(targets.length) +
            ' elements; the copies went into the first',
        );
      }

      // Resolve the insertion point. A `before`/`after` reference is looked for *inside* the
      // target: a position naming an element somewhere else in the document is not a position in
      // this container, and inserting anyway would put the clone somewhere the rule never said.
      let container: Element = target;
      let anchor: Node | null = null;
      if (clone.position.at === 'prepend') {
        anchor = target.firstElementChild;
      } else if (clone.position.at === 'append') {
        anchor = null;
      } else {
        const references = queryAll(target, clone.position.selector);
        if (references === null) {
          result.detail =
            "the browser could not evaluate the position selector '" + clone.position.selector + "'";
          pending.push({ result: result, checks: checks });
          continue;
        }
        const reference = references[0];
        if (reference === undefined) {
          result.detail =
            "position " +
            clone.position.at +
            ": '" +
            clone.position.selector +
            "' matched no element inside '" +
            clone.into +
            "', so nothing was inserted";
          pending.push({ result: result, checks: checks });
          continue;
        }
        // The reference may be a grandchild of the target, so the copies go into *its* parent:
        // "before this element" is a position in the element's own container, not in the target's.
        container = reference.parentElement ?? target;
        anchor = clone.position.at === 'before' ? reference : reference.nextSibling;
      }

      const inserted: HTMLElement[] = [];
      const parents: Array<Element | null> = [];
      for (let i = 0; i < clone.times; i += 1) {
        const copy = parseElement(clone.source.html);
        if (copy === null) {
          details.push('the clone source html produced no element to insert');
          break;
        }
        copy.setAttribute(CLONE_MARK, rule.id);
        // A null anchor appends. Each copy then anchors the next one after itself, so `times: 3`
        // reads top to bottom in the order the copies were made, whichever end of the container
        // the position named.
        container.insertBefore(copy, anchor);
        anchor = copy.nextSibling;
        inserted.push(copy);
        parents.push(copy.parentElement);
        stamp(copy, rule.id, 'clone');
      }
      result.changed = inserted.length;
      for (let i = 0; i < inserted.length; i += 1) {
        const copy = inserted[i] as HTMLElement;
        const parent = parents[i] ?? null;
        checks.push(() => copy.isConnected && copy.parentElement === parent);
      }
      if (details.length > 0) result.detail = details.join('; ');

      // The style comparison runs in the verification pass, not here: computed styles are only
      // final once every rule has been applied, and this is the last look at the page before the
      // screenshot.
      const onVerify = (): void => {
        const view = doc.defaultView;
        const first = inserted[0];
        if (view === null || first === undefined || !first.isConnected) return;
        const computed = view.getComputedStyle(first);
        const differences: CloneStyleDifference[] = [];
        let compared = 0;
        for (const property of args.cloneStyleProps) {
          const source = clone.source.computed[property];
          if (source === undefined || source === '') continue;
          compared += 1;
          const here = computed.getPropertyValue(property);
          if (normalize(here) !== normalize(source)) {
            differences.push({ property: property, source: source, target: here });
          }
        }
        result.clone = {
          origin: clone.source.origin,
          compared: compared,
          differences: differences,
          material: differences.length > 0,
        };
      };
      pending.push({ result: result, checks: checks, onVerify: onVerify });
      continue;
    }

    /* ------------------------------------------------------------------ the element verbs */

    const found = queryAll(doc, rule.match);
    if (found === null) {
      result.detail = "the browser could not evaluate the selector '" + rule.match + "'";
      pending.push({ result: result, checks: checks });
      continue;
    }
    result.matched = found.length;

    if (rule.verb === 'style') {
      const rejected: string[] = [];
      for (const el of found) {
        const landed: Array<{ name: string; value: string }> = [];
        for (const declaration of rule.style) {
          // `important` so a rule is not quietly outranked by an `!important` stylesheet
          // declaration: a variant that silently does nothing is the failure this whole slice is
          // built to make impossible.
          el.style.setProperty(declaration.name, declaration.value, 'important');
          const readBack = el.style.getPropertyValue(declaration.name);
          if (readBack === '') {
            if (rejected.indexOf(declaration.name) === -1) rejected.push(declaration.name);
            continue;
          }
          landed.push({ name: declaration.name, value: readBack });
        }
        if (landed.length === 0) continue;
        result.changed += 1;
        stamp(el, rule.id, 'style');
        checks.push(() => {
          if (!el.isConnected) return false;
          for (const declaration of landed) {
            if (el.style.getPropertyValue(declaration.name) !== declaration.value) return false;
          }
          return true;
        });
      }
      if (rejected.length > 0) {
        result.detail =
          'the browser rejected ' +
          String(rejected.length) +
          ' declaration' +
          (rejected.length === 1 ? '' : 's') +
          ' (' +
          rejected.join(', ') +
          ') as invalid';
      }
    } else if (rule.verb === 'text') {
      for (const el of found) {
        el.textContent = rule.text;
        const landed = el.textContent ?? '';
        result.changed += 1;
        stamp(el, rule.id, 'text');
        checks.push(() => el.isConnected && (el.textContent ?? '') === landed);
      }
    } else if (rule.verb === 'hide') {
      for (const el of found) {
        el.style.setProperty('display', 'none', 'important');
        if (el.style.getPropertyValue('display') !== 'none') continue;
        result.changed += 1;
        stamp(el, rule.id, 'hide');
        checks.push(() => el.isConnected && el.style.getPropertyValue('display') === 'none');
      }
    } else {
      const placement = rule.order;
      const details: string[] = [];
      for (const el of found) {
        const parent = el.parentElement;
        if (parent === null) {
          details.push('an element has no parent to be reordered within');
          continue;
        }

        if (placement.at === 'first' || placement.at === 'last') {
          if (placement.at === 'first') {
            const first = parent.firstElementChild;
            if (first !== el) parent.insertBefore(el, first);
          } else if (parent.lastElementChild !== el) {
            parent.appendChild(el);
          }
          const settled = el.parentElement;
          result.changed += 1;
          stamp(el, rule.id, 'order');
          const wantFirst = placement.at === 'first';
          checks.push(() => {
            if (!el.isConnected || el.parentElement !== settled) return false;
            return wantFirst ? el.previousElementSibling === null : el.nextElementSibling === null;
          });
          continue;
        }

        // A reference is looked for among the element's own siblings first, which is what
        // "reposition among siblings" means; only if none is there does the search widen to the
        // document, so `before: [data-test=sidebar-top]` can also move an element into a different
        // container. Both stay inside what the application rendered — no UI is invented either way.
        const candidates = queryAll(doc, placement.selector);
        if (candidates === null) {
          details.push("the browser could not evaluate '" + placement.selector + "'");
          continue;
        }
        let reference: HTMLElement | null = null;
        for (const candidate of candidates) {
          if (candidate === el || el.contains(candidate)) continue;
          if (candidate.parentElement === parent) {
            reference = candidate;
            break;
          }
        }
        if (reference === null) {
          for (const candidate of candidates) {
            if (candidate === el || el.contains(candidate)) continue;
            reference = candidate;
            break;
          }
        }
        if (reference === null) {
          details.push(
            placement.at +
              ": '" +
              placement.selector +
              "' matched no element this one could be moved next to",
          );
          continue;
        }
        const host = reference.parentElement;
        if (host === null) {
          details.push("the element matched by '" + placement.selector + "' has no parent");
          continue;
        }
        if (placement.at === 'before') host.insertBefore(el, reference);
        else host.insertBefore(el, reference.nextSibling);
        result.changed += 1;
        stamp(el, rule.id, 'order');
        const before = placement.at === 'before';
        const anchor = reference;
        checks.push(() => {
          if (!el.isConnected || !anchor.isConnected) return false;
          if (el.parentElement === null || el.parentElement !== anchor.parentElement) return false;
          return before ? indexOf(el) < indexOf(anchor) : indexOf(el) > indexOf(anchor);
        });
      }
      if (details.length > 0) result.detail = details.join('; ');
    }

    pending.push({ result: result, checks: checks });
  }

  /* ------------------------------------------------------------------ verification (D22) */

  if (onApplied !== undefined) onApplied();

  for (const entry of pending) {
    const result = entry.result;
    let verified = 0;
    for (const check of entry.checks) {
      if (check()) verified += 1;
    }
    result.verified = verified;
    if (entry.onVerify !== undefined) entry.onVerify();

    // A rule that changed nothing is `unmatched` whatever its selector matched, and never
    // `reverted`: reverted means "this was true and then stopped being true", which is the one
    // thing D22 exists to shout about, and diluting it with rules that never took effect would
    // make the loud warning mean two different things.
    if (result.changed === 0) {
      result.outcome = 'unmatched';
      if (result.detail === undefined) {
        result.detail =
          result.matched === 0
            ? 'the selector matched no element'
            : 'matched ' +
              String(result.matched) +
              ' element' +
              (result.matched === 1 ? '' : 's') +
              ' but changed none of them';
      }
      continue;
    }
    if (verified < result.changed) {
      result.outcome = 'reverted';
      const lost = result.changed - verified;
      const reverted =
        String(lost) +
        ' of ' +
        String(result.changed) +
        ' changed element' +
        (result.changed === 1 ? '' : 's') +
        ' no longer carried the change when the page was captured';
      result.detail = result.detail === undefined ? reverted : result.detail + '; ' + reverted;
      continue;
    }
    result.outcome = 'applied';
  }

  return {
    variant: variant,
    rules: results,
    attributions: attributions,
    stylesInjected: stylesInjected,
  };
}

/**
 * Extract a clone source from the page it lives on (§4, D23).
 *
 * Runs in the *source* page's context — a step this run already visited, or a URL opened during it
 * — so what is copied is the same revision, under the same determinism knobs, scenario and network
 * mode as the target (§9). It takes the element's `outerHTML` **and the page's injected `<style>`
 * elements**, because a component whose CSS-in-JS rules were injected when it mounted here would
 * render unstyled anywhere it never mounts.
 */
export function extractCloneSourceInPage(
  args: CloneExtractArgs,
  doc: Document = document,
): CloneExtractResult {
  const result: CloneExtractResult = {
    ruleId: args.ruleId,
    origin: args.origin,
    match: args.match,
    found: false,
    matched: 0,
    html: '',
    styles: [],
    computed: {},
  };

  let found: HTMLElement[];
  try {
    found = Array.prototype.slice.call(doc.querySelectorAll(args.match)) as HTMLElement[];
  } catch {
    result.detail = "the browser could not evaluate the selector '" + args.match + "'";
    return result;
  }

  result.matched = found.length;
  const element = found[0];
  if (element === undefined) {
    result.detail = "no element matched '" + args.match + "'";
    return result;
  }

  result.found = true;
  result.html = element.outerHTML;

  const view = doc.defaultView;
  if (view !== null) {
    const computed = view.getComputedStyle(element);
    for (const property of args.styleProps) {
      result.computed[property] = computed.getPropertyValue(property);
    }
  }

  let styles: HTMLElement[];
  try {
    styles = Array.prototype.slice.call(doc.querySelectorAll('style')) as HTMLElement[];
  } catch {
    styles = [];
  }
  for (const style of styles) {
    const id = style.getAttribute('id');
    if (id !== null && args.excludeStyleIds.indexOf(id) !== -1) continue;
    const css = style.textContent ?? '';
    if (css === '') continue;
    if (result.styles.indexOf(css) !== -1) continue;
    result.styles.push(css);
  }

  return result;
}
