//! Precedence levels and operand positions (math-syntax sections 5 and 12, invariant N1).
//!
//! Shared by the printer (grouping parentheses in box positions) and by normalization
//! (required `Paren` nodes everywhere else).

use crate::ast::{Expr, ExprKind};

/// Precedence level of a node: the level of math-syntax section 5 (higher binds tighter).
pub(crate) fn level(kind: &ExprKind) -> u8 {
    use ExprKind as K;
    match kind {
        K::Range { .. } => 2,
        // A local definition binds looser than every operand position allows, so a bare one is
        // wrapped in a `Paren` (N1, N11); the parentheses belong to the form.
        K::InlineDef { .. } => 1,
        K::Or { .. } | K::Xor { .. } => 3,
        K::And { .. } => 4,
        K::Not { .. } => 5,
        K::Eq { .. }
        | K::Ne { .. }
        | K::Lt { .. }
        | K::Gt { .. }
        | K::Le { .. }
        | K::Ge { .. }
        | K::In { .. } => 6,
        // The polar form sits between + and ·; the positions below place it.
        K::Add { .. } | K::Sub { .. } | K::Polar { .. } => 7,
        K::Mul { .. }
        | K::InlineDiv { .. }
        | K::Cross { .. }
        | K::Conv { .. }
        | K::CircConv { .. }
        | K::Juxt { .. } => 8,
        K::Sum { .. }
        | K::Prod { .. }
        | K::Integral { .. }
        | K::Deriv { .. }
        | K::Partial { .. }
        | K::Gradient { .. }
        | K::Limit { .. } => 9,
        K::Neg { .. } => 10,
        K::Div { .. } => 11,
        K::Pow { .. } => 12,
        K::Call { .. }
        | K::JuliaCall { .. }
        | K::Index { .. }
        | K::Column { .. }
        | K::Row { .. }
        | K::Transpose { .. }
        | K::Factorial { .. }
        | K::Percent { .. }
        | K::Permille { .. }
        | K::PrimeDeriv { .. } => 13,
        K::Num { .. }
        | K::Imag { .. }
        | K::Str { .. }
        | K::Placeholder
        | K::Ident { .. }
        | K::Paren { .. }
        | K::Conj { .. }
        | K::RealPart { .. }
        | K::ImagPart { .. }
        | K::Abs { .. }
        | K::Det { .. }
        | K::Norm { .. }
        | K::Vectorize { .. }
        | K::Root { .. }
        | K::Matrix { .. }
        | K::EllipsisCell { .. }
        | K::Program { .. } => 14,
    }
}

/// A non-box operand position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Pos {
    /// `add-expr`: range bounds, binder bounds, limit target.
    AddExpr,
    OrLeft,
    OrRight,
    AndLeft,
    AndRight,
    NotOperand,
    CmpLeft,
    CmpRight,
    AddLeft,
    AddRight,
    /// Left operand of `·`, `÷`, `×` or juxtaposition (see also [`ends_in_big_op`]).
    MulLeft,
    /// Right operand of `·`, `÷`, `×`: `mul-operand`.
    MulRight,
    /// Right operand of juxtaposition: `juxt-operand` (no leading `-`).
    JuxtRight,
    /// Either operand of `∠`: a `mul-expr`.
    PolarOperand,
    /// Body of `∑ ∏ ∫ ⅆ ∂ \lim`: `mul-expr`.
    BigBody,
    NegOperand,
    PowBase,
    /// Base of a postfix operator (call, index, column, row, `ᵀ`, `!`, `′`).
    PostfixBase,
}

/// Does `e` fit in position `pos` without a `Paren` node?
pub(crate) fn fits(pos: Pos, e: &Expr) -> bool {
    let l = level(&e.kind);
    match pos {
        Pos::AddExpr => l >= 7,
        Pos::OrLeft => l >= 3,
        Pos::OrRight => l >= 4,
        Pos::AndLeft => l >= 4,
        Pos::AndRight => l >= 5,
        Pos::NotOperand => l >= 5,
        Pos::CmpLeft => l >= 6,
        Pos::CmpRight => l >= 7,
        Pos::AddLeft => l >= 7,
        // A polar form binds tighter than + and -.
        Pos::AddRight => l >= 8 || matches!(e.kind, ExprKind::Polar { .. }),
        Pos::PolarOperand => l >= 8,
        Pos::MulLeft => l >= 8,
        Pos::MulRight => l >= 9,
        Pos::JuxtRight => l == 9 || l >= 11,
        Pos::BigBody => l >= 8,
        Pos::NegOperand => l >= 9,
        Pos::PowBase => l >= 13,
        // A radical's operand would absorb the postfix operator (`√x[i]` is `√(x[i])`).
        Pos::PostfixBase => l >= 13 && !matches!(e.kind, ExprKind::Root { .. }),
    }
}

/// True when the right spine of `e` (through `·`, `÷`, `×`, juxtaposition and unary minus)
/// ends in a big operator, whose body would absorb factors that follow `e`.
pub(crate) fn ends_in_big_op(e: &Expr) -> bool {
    use ExprKind as K;
    match &e.kind {
        k if k.is_big_op() => true,
        K::Mul { right, .. }
        | K::InlineDiv { right, .. }
        | K::Cross { right, .. }
        | K::Conv { right, .. }
        | K::CircConv { right, .. }
        | K::Juxt { right, .. } => ends_in_big_op(right),
        K::Neg { expr } => ends_in_big_op(expr),
        _ => false,
    }
}

/// A box position (math-syntax D5): grouping parentheses there create no node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BoxPos {
    Numerator,
    Denominator,
    Exponent,
    Radicand,
}

/// Does the printer need one grouping pair around the box content `e`? (rule 13.7)
pub(crate) fn box_needs_group(pos: BoxPos, e: &Expr) -> bool {
    // A visible pair the user typed is written doubled in a box (D5), except the pair of a
    // parenthesised local definition: it is the only pair the form can have, so in a box it is
    // the grouping pair too.
    if let ExprKind::Paren { expr } = &e.kind {
        return !matches!(expr.kind, ExprKind::InlineDef { .. });
    }
    let l = level(&e.kind);
    match pos {
        BoxPos::Numerator => l < 11,
        BoxPos::Denominator => l < 12,
        BoxPos::Exponent => !fits_exponent(e),
        // `[` right after `√` would be read as the root index (disambiguation rule 6).
        BoxPos::Radicand => l < 13 || starts_with_matrix(e),
    }
}

/// True when the printed text of a postfix-level expression starts with `[`.
fn starts_with_matrix(e: &Expr) -> bool {
    use ExprKind as K;
    match &e.kind {
        K::Matrix { .. } => true,
        K::Call { callee: x, .. }
        | K::Index { base: x, .. }
        | K::Column { base: x, .. }
        | K::Row { base: x, .. }
        | K::Transpose { expr: x }
        | K::Factorial { expr: x }
        | K::Percent { expr: x }
        | K::Permille { expr: x }
        | K::PrimeDeriv { function: x, .. } => starts_with_matrix(x),
        _ => false,
    }
}

/// The `exponent` rule: `"-" exponent | pow-expr`.
fn fits_exponent(e: &Expr) -> bool {
    match &e.kind {
        ExprKind::Neg { expr } => fits_exponent(expr),
        k => level(k) >= 12,
    }
}
