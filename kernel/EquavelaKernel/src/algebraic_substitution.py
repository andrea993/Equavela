"""Bounded, directional matching for symbolic substitution."""

import sympy as sp
from sympy.core.traversal import bottom_up

MAX_OPERATIONS = 200
MAX_NODES = 500
MAX_SYMBOLS = 6
MAX_SUMS = 24
MAX_TERMS = 30
MAX_DEGREE = 8
MAX_COEFFICIENTS = 4


def _size_depth(expr):
    size = 0
    depth = 0
    stack = [(expr, 1)]
    while stack:
        node, level = stack.pop()
        size += 1
        depth = max(depth, level)
        if size > MAX_NODES:
            break
        stack.extend((arg, level + 1) for arg in node.args)
    return size, depth


def _occurrences(expr, symbols):
    return sum(1 for node in sp.preorder_traversal(expr) if node in symbols)


def algebraic_substitute(value, pattern, replacement):
    """Apply one rule, first as ordinary substitution and then in polynomial sums."""
    direct = value.subs(pattern, replacement)
    if not isinstance(direct, sp.Expr) or not isinstance(pattern, sp.Expr):
        return direct
    # Plain identifiers retain their ordinary substitution semantics.
    if pattern.is_Atom or pattern == replacement or not pattern.free_symbols:
        return direct
    size, _ = _size_depth(direct)
    if size > MAX_NODES or sp.count_ops(direct) > MAX_OPERATIONS:
        return direct
    symbols = pattern.free_symbols
    if len(symbols) > MAX_SYMBOLS:
        return direct

    marker = sp.Dummy("substitution")
    visited = 0

    def rewrite_polynomial_terms(node):
        polynomial, other = [], []
        for term in node.args:
            if term.free_symbols & symbols and term.is_polynomial(*symbols):
                polynomial.append(term)
            else:
                other.append(term)
        if len(polynomial) < 2 or not other:
            return node
        part = sp.Add(*polynomial)
        return rewrite(part) + sp.Add(*other)

    def rewrite(node):
        nonlocal visited
        if not isinstance(node, sp.Add) or not symbols <= node.free_symbols:
            return node
        visited += 1
        if visited > MAX_SUMS or len(node.args) > MAX_TERMS:
            return node
        # Avoid expanding products or powers of sums just to construct a polynomial.
        if any(isinstance(part, sp.Pow) and isinstance(part.base, sp.Add)
               or isinstance(part, sp.Mul) and any(isinstance(arg, sp.Add) for arg in part.args)
               for part in sp.preorder_traversal(node)):
            return rewrite_polynomial_terms(node)
        variables = sorted(symbols, key=sp.default_sort_key)
        try:
            # Other symbols and functions are coefficients, provided they do not
            # depend non-polynomially on the variables in the requested pattern.
            poly = sp.Poly(node, *variables, domain="EX")
            if poly.total_degree() > MAX_DEGREE or len(poly.terms()) > MAX_TERMS:
                return node
        except (sp.PolynomialError, TypeError, ValueError):
            return rewrite_polynomial_terms(node)

        forms = [node, sp.factor_terms(node)]
        all_variables = sorted(node.free_symbols, key=sp.default_sort_key)
        if len(all_variables) <= MAX_SYMBOLS:
            try:
                # General factorization is restricted to polynomial sums, so it
                # cannot cancel poles in a non-polynomial coefficient.
                sp.Poly(node, *all_variables)
                forms.append(sp.factor(node))
            except (sp.PolynomialError, TypeError, ValueError):
                pass
        extra = sorted(node.free_symbols - symbols - replacement.free_symbols, key=sp.default_sort_key)
        for coefficient in extra[:MAX_COEFFICIENTS]:
            forms.append(sp.collect(node, coefficient))
        seen = set()
        matches = []
        # Divide by the whole pattern, but reject a remainder that contains a
        # partial pattern term: that would solve the rule for one variable.
        pattern_vars = sorted(symbols, key=sp.default_sort_key)
        try:
            divisor = sp.Poly(pattern, *pattern_vars, domain="EX")
            dividend = sp.Poly(node, *pattern_vars, domain="EX")
            quotient, remainder = sp.div(dividend, divisor)
            terms = [monomial for monomial, _ in divisor.terms() if any(monomial)]
            partial = any(
                all(a >= b for a, b in zip(monomial, pattern_term))
                for monomial, _ in remainder.terms()
                for pattern_term in terms
            )
            if not quotient.is_zero and terms and not partial:
                coefficient = sp.factor_terms(quotient.as_expr()).subs(pattern, marker)
                matches.append(coefficient * marker + remainder.as_expr())
        except (sp.PolynomialError, TypeError, ValueError, ZeroDivisionError):
            pass

        best = None
        best_score = None
        original_occurrences = _occurrences(node, symbols)
        for form in forms:
            if form in seen:
                continue
            seen.add(form)
            matches.append(form.subs(pattern, marker))
        for matched in matches:
            if not matched.has(marker):
                continue
            size, depth = _size_depth(matched)
            if size > MAX_NODES:
                continue
            hits = sum(1 for part in sp.preorder_traversal(matched) if part == marker)
            removed = original_occurrences - _occurrences(matched, symbols)
            score = (hits, removed, -int(sp.count_ops(matched)), -size, -depth)
            if best_score is None or score > best_score:
                best, best_score = matched, score
        return node if best is None else best.xreplace({marker: replacement})

    try:
        return bottom_up(direct, rewrite)
    except Exception:
        return direct


def substitute_relation(value, left, right):
    """Use a symbol as a name for an expression when that expression occurs."""
    if (isinstance(value, sp.Expr) and isinstance(left, sp.Symbol) and not value.has(left)
            and isinstance(right, sp.Expr) and not right.is_Atom and right.free_symbols
            and left not in right.free_symbols):
        reversed_result = algebraic_substitute(value, right, left)
        if reversed_result != value:
            return reversed_result
    if (isinstance(value, sp.Expr) and isinstance(left, sp.Pow) and left.base.is_Symbol
            and left.exp.is_Integer and left.exp >= 2
            and isinstance(right, sp.Add) and left.free_symbols.isdisjoint(right.free_symbols)):
        reversed_result = algebraic_substitute(value, right, left)
        if _occurrences(reversed_result, right.free_symbols) < _occurrences(value, right.free_symbols):
            return reversed_result
    return algebraic_substitute(value, left, right)


def collect_expression(value, target):
    """Collect by an expression, including bounded algebraic matches."""
    marker = sp.Dummy("collect")
    marked = algebraic_substitute(value, target, marker)
    if not marked.has(marker):
        return value
    numerator, denominator = sp.fraction(sp.together(marked))
    result = sp.collect(sp.expand(numerator), marker) / denominator
    return result.xreplace({marker: target})
