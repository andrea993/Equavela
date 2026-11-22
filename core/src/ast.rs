//! Canonical AST of worksheet math.
//!
//! Every node carries a [`Span`]: the byte range of the node in the text it was parsed
//! from (a default, empty span for nodes built in code). Spans are metadata for error
//! reporting: **two spans always compare equal**, so `==` on AST nodes is structural
//! equality and the round-trip invariant `parse(print(ast)) == ast` can be written
//! literally. Use [`Span::range`] to compare positions.
//!
//! The JSON form (serde) is used by the kernel protocol and the editor: every node is an
//! object with a `"type"` field naming the variant and a `"span"` field
//! (`{"start": .., "end": ..}`, optional on input).

use serde::{Deserialize, Serialize};
use std::ops::Range;

/// Byte range of a node in the source text. Compares equal to every other span.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        Span { start, end }
    }

    /// The byte range, for comparing positions (`==` on spans is always true).
    pub fn range(&self) -> Range<usize> {
        self.start..self.end
    }

    /// The smallest span covering both `self` and `other`.
    pub fn to(self, other: Span) -> Span {
        Span::new(self.start.min(other.start), self.end.max(other.end))
    }
}

impl PartialEq for Span {
    fn eq(&self, _other: &Span) -> bool {
        true
    }
}

impl Eq for Span {}

// ---------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------

/// An explicit label. Without one the label is contextual.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Label {
    Var,
    Fn,
    Unit,
    Const,
    Sys,
    Kw,
    /// Julia function label: an imported Julia function.
    Julia,
}

impl Label {
    pub const ALL: [Label; 7] = [
        Label::Var,
        Label::Fn,
        Label::Unit,
        Label::Const,
        Label::Sys,
        Label::Kw,
        Label::Julia,
    ];

    /// The canonical (short) suffix word, written after `@`.
    pub fn as_str(self) -> &'static str {
        match self {
            Label::Var => "var",
            Label::Fn => "fn",
            Label::Unit => "unit",
            Label::Const => "const",
            Label::Sys => "sys",
            Label::Kw => "kw",
            Label::Julia => "julia",
        }
    }

    /// Accepts the short words and the long spellings (`variable`, `function`, …).
    pub fn from_word(word: &str) -> Option<Label> {
        Some(match word {
            "var" | "variable" => Label::Var,
            "fn" | "function" => Label::Fn,
            "unit" => Label::Unit,
            "const" | "constant" => Label::Const,
            "sys" | "system" => Label::Sys,
            "kw" | "keyword" => Label::Kw,
            "julia" => Label::Julia,
            _ => return None,
        })
    }
}

/// One part of a name: base text or a literal subscript.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Segment {
    pub text: String,
    pub subscript: bool,
}

/// A name with its literal-subscript segments and optional explicit label.
///
/// `F_max` is `[("F", base), ("max", subscript)]`; `H_{2}SO_{4}` has four segments.
/// Normalized (N3): segments are non-empty, adjacent segments differ in kind, the first
/// segment is a base.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Name {
    pub segments: Vec<Segment>,
    #[serde(default)]
    pub label: Option<Label>,
}

impl Name {
    /// A name with one base segment and no label.
    pub fn plain(text: &str) -> Name {
        Name {
            segments: vec![Segment {
                text: text.to_string(),
                subscript: false,
            }],
            label: None,
        }
    }

    /// A name with a base and one literal subscript: `Name::sub("F", "max")` is `F_max`.
    pub fn sub(base: &str, subscript: &str) -> Name {
        Name {
            segments: vec![
                Segment {
                    text: base.to_string(),
                    subscript: false,
                },
                Segment {
                    text: subscript.to_string(),
                    subscript: true,
                },
            ],
            label: None,
        }
    }

    pub fn with_label(mut self, label: Label) -> Name {
        self.label = Some(label);
        self
    }

    /// The single base text when the name has one base segment and no label.
    pub fn as_simple(&self) -> Option<&str> {
        match self.segments.as_slice() {
            [s] if !s.subscript && self.label.is_none() => Some(&s.text),
            _ => None,
        }
    }
}

/// A name used in a binder, a parameter list, a loop header or a keyword position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ident {
    pub name: Name,
    #[serde(default)]
    pub span: Span,
}

impl Ident {
    pub fn new(name: Name) -> Ident {
        Ident {
            name,
            span: Span::default(),
        }
    }
}

// ---------------------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------------------

/// `i` or `j` in an imaginary literal (`1j`, `2.5i`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImagUnit {
    I,
    J,
}

impl ImagUnit {
    pub fn as_char(self) -> char {
        match self {
            ImagUnit::I => 'i',
            ImagUnit::J => 'j',
        }
    }
}

/// The drawing form of a display-only ellipsis cell: `⋯` along a row, `⋮` down a column,
/// `⋱` along the diagonal. One meaning, three glyphs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EllipsisForm {
    Horizontal,
    Vertical,
    Diagonal,
}

impl EllipsisForm {
    pub const ALL: [EllipsisForm; 3] = [
        EllipsisForm::Horizontal,
        EllipsisForm::Vertical,
        EllipsisForm::Diagonal,
    ];

    /// The canonical glyph: `⋯`, `⋮` or `⋱`.
    pub fn glyph(self) -> &'static str {
        match self {
            EllipsisForm::Horizontal => "⋯",
            EllipsisForm::Vertical => "⋮",
            EllipsisForm::Diagonal => "⋱",
        }
    }
}

/// Side of a limit: `\lim[x, a]` (both), `\lim[x, a, -]` (left), `\lim[x, a, +]` (right).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LimitSide {
    Both,
    Left,
    Right,
}

/// Bounds of a sum, product or definite integral (`k ∈ lo..hi`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bounds {
    pub lo: Box<Expr>,
    pub hi: Box<Expr>,
    /// How the lower slot was typed. Only sums and
    /// products use anything but `In`; the three evaluate the same.
    #[serde(default, skip_serializing_if = "BoundGlyph::is_in")]
    pub glyph: BoundGlyph,
}

/// The glyph between the index and the lower bound of a sum or product.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BoundGlyph {
    #[default]
    In,
    Equals,
    Define,
}

impl BoundGlyph {
    pub fn is_in(&self) -> bool {
        *self == BoundGlyph::In
    }
}

/// An expression node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Expr {
    #[serde(default)]
    pub span: Span,
    #[serde(flatten)]
    pub kind: ExprKind,
}

impl Expr {
    pub fn new(kind: ExprKind, span: Span) -> Expr {
        Expr { span, kind }
    }

    /// A node built in code (default span).
    pub fn synth(kind: ExprKind) -> Expr {
        Expr {
            span: Span::default(),
            kind,
        }
    }
}

/// The expression nodes of math-syntax section 11.3, plus [`ExprKind::JuliaCall`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ExprKind {
    /// Unsigned number literal, text verbatim (`1.50`, `.5`, `1.5e-3`).
    Num {
        text: String,
    },
    /// Imaginary literal: number text and unit symbol (`1j`, `2.5i`).
    Imag {
        text: String,
        symbol: ImagUnit,
    },
    /// String literal; `text` is the decoded text (escapes resolved).
    Str {
        text: String,
    },
    /// Empty operand slot `□`.
    Placeholder,
    /// A name.
    Ident {
        name: Name,
    },
    /// Visible parentheses.
    Paren {
        expr: Box<Expr>,
    },
    /// A parenthesised local definition `(target ← e)` as an operand:
    /// the value of the node is the value of `value` and no name of `target` is
    /// bound. The parentheses belong to the form, so the node is always the
    /// content of an `ExprKind::Paren` and a bare one is wrapped by normalization (N11).
    InlineDef {
        target: Target,
        value: Box<Expr>,
    },

    Neg {
        expr: Box<Expr>,
    },
    Not {
        expr: Box<Expr>,
    },
    Factorial {
        expr: Box<Expr>,
    },
    /// the reference application's postfix percent `x%`: `x` divided by 100.
    Percent {
        expr: Box<Expr>,
    },
    /// The per mille `x‰`: `x` divided by 1000.
    Permille {
        expr: Box<Expr>,
    },
    Transpose {
        expr: Box<Expr>,
    },
    Conj {
        expr: Box<Expr>,
    },
    /// The real part `\Re(z)`, drawn ℜ(z).
    RealPart {
        expr: Box<Expr>,
    },
    /// The imaginary part `\Im(z)`, drawn ℑ(z).
    ImagPart {
        expr: Box<Expr>,
    },
    /// Dispatching `|x|`.
    Abs {
        expr: Box<Expr>,
    },
    /// Explicit determinant `\det(M)`.
    Det {
        expr: Box<Expr>,
    },
    Norm {
        expr: Box<Expr>,
    },
    Vectorize {
        expr: Box<Expr>,
    },

    Add {
        left: Box<Expr>,
        right: Box<Expr>,
        #[serde(default)]
        split: bool,
    },
    Sub {
        left: Box<Expr>,
        right: Box<Expr>,
        #[serde(default)]
        split: bool,
    },
    Mul {
        left: Box<Expr>,
        right: Box<Expr>,
        #[serde(default)]
        split: bool,
    },
    InlineDiv {
        left: Box<Expr>,
        right: Box<Expr>,
        #[serde(default)]
        split: bool,
    },
    /// Implicit multiplication (juxtaposition, `3.5 m`).
    Juxt {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Cross {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// The linear convolution `a ∗ b`.
    Conv {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// The circular convolution `a ⊛ b`.
    CircConv {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// The polar form `r∠θ`.
    Polar {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// Stacked fraction `a/b`.
    Div {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Pow {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Eq {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Ne {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Lt {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Gt {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Le {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Ge {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    In {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    And {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Or {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Xor {
        left: Box<Expr>,
        right: Box<Expr>,
    },

    /// `√x` (index `None`) or `√[n](x)`.
    Root {
        index: Option<Box<Expr>>,
        radicand: Box<Expr>,
    },
    Call {
        callee: Box<Expr>,
        args: Vec<Arg>,
    },
    /// Qualified Julia call `Package::name(args)`, or `julia.name(args)`, a name
    /// of a Julia block. `bare` is `julia.name` with no parentheses: the Julia value,
    /// or the function a definition registers.
    JuliaCall {
        package: String,
        name: String,
        args: Vec<Arg>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        bare: bool,
    },
    /// `v[i]` or `M[i, j]` (one or two indices).
    Index {
        base: Box<Expr>,
        indices: Vec<Expr>,
    },
    Column {
        base: Box<Expr>,
        index: Box<Expr>,
    },
    Row {
        base: Box<Expr>,
        index: Box<Expr>,
    },
    /// `f′` (order 1), `f′′` (order 2), …
    PrimeDeriv {
        function: Box<Expr>,
        order: u32,
    },
    /// Cells in row-major order; `cells.len() == rows·cols`.
    Matrix {
        rows: usize,
        cols: usize,
        cells: Vec<Expr>,
    },
    /// A display-only ellipsis cell of a matrix, `⋯` `⋮` `⋱`.
    /// It is a whole cell and never an operand; a matrix that holds one is never evaluated.
    EllipsisCell {
        form: EllipsisForm,
    },
    /// `first..last` or `first, second..last` (only where math-syntax 6.4 allows it).
    Range {
        first: Box<Expr>,
        second: Option<Box<Expr>>,
        last: Box<Expr>,
    },
    /// `index` is the free lower slot and then `var` is the empty
    /// name; such a sum is displayed but is an evaluation error.
    Sum {
        var: Ident,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<Box<Expr>>,
        bounds: Option<Bounds>,
        body: Box<Expr>,
    },
    Prod {
        var: Ident,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<Box<Expr>>,
        bounds: Option<Bounds>,
        body: Box<Expr>,
    },
    Integral {
        var: Ident,
        bounds: Option<Bounds>,
        algorithm: Option<Ident>,
        body: Box<Expr>,
    },
    Deriv {
        var: Ident,
        order: Option<Box<Expr>>,
        body: Box<Expr>,
    },
    Partial {
        var: Ident,
        order: Option<Box<Expr>>,
        body: Box<Expr>,
    },
    /// The gradient `∇[x, y] e`: the column of the partial derivatives.
    Gradient {
        vars: Vec<Ident>,
        body: Box<Expr>,
    },
    Limit {
        var: Ident,
        target: Box<Expr>,
        side: LimitSide,
        body: Box<Expr>,
    },
    Program {
        body: Vec<Stmt>,
    },
}

/// A call argument: an expression or an inline definition `A ← e`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Arg {
    Expr {
        expr: Expr,
    },
    InlineDef {
        target: Target,
        value: Expr,
        #[serde(default)]
        span: Span,
    },
}

/// Unary operators that share the `{ expr }` shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UnaryOp {
    Neg,
    Not,
    Factorial,
    Percent,
    Permille,
    Transpose,
    Conj,
    RealPart,
    ImagPart,
    Abs,
    Det,
    Norm,
    Vectorize,
}

/// Binary operators that share the `{ left, right }` shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    InlineDiv,
    Juxt,
    Cross,
    Conv,
    CircConv,
    Polar,
    Div,
    Pow,
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    In,
    And,
    Or,
    Xor,
}

impl BinaryOp {
    pub const ALL: [BinaryOp; 21] = [
        BinaryOp::Add,
        BinaryOp::Sub,
        BinaryOp::Mul,
        BinaryOp::InlineDiv,
        BinaryOp::Juxt,
        BinaryOp::Cross,
        BinaryOp::Conv,
        BinaryOp::CircConv,
        BinaryOp::Polar,
        BinaryOp::Div,
        BinaryOp::Pow,
        BinaryOp::Eq,
        BinaryOp::Ne,
        BinaryOp::Lt,
        BinaryOp::Gt,
        BinaryOp::Le,
        BinaryOp::Ge,
        BinaryOp::In,
        BinaryOp::And,
        BinaryOp::Or,
        BinaryOp::Xor,
    ];

    /// Operators that may carry an equation break (N8).
    pub fn splittable(self) -> bool {
        matches!(
            self,
            BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::InlineDiv
        )
    }
}

impl UnaryOp {
    pub const ALL: [UnaryOp; 13] = [
        UnaryOp::Neg,
        UnaryOp::Not,
        UnaryOp::Factorial,
        UnaryOp::Percent,
        UnaryOp::Permille,
        UnaryOp::Transpose,
        UnaryOp::Conj,
        UnaryOp::RealPart,
        UnaryOp::ImagPart,
        UnaryOp::Abs,
        UnaryOp::Det,
        UnaryOp::Norm,
        UnaryOp::Vectorize,
    ];
}

impl ExprKind {
    /// Builds a unary node.
    pub fn unary(op: UnaryOp, expr: Expr) -> ExprKind {
        let expr = Box::new(expr);
        match op {
            UnaryOp::Neg => ExprKind::Neg { expr },
            UnaryOp::Not => ExprKind::Not { expr },
            UnaryOp::Factorial => ExprKind::Factorial { expr },
            UnaryOp::Percent => ExprKind::Percent { expr },
            UnaryOp::Permille => ExprKind::Permille { expr },
            UnaryOp::Transpose => ExprKind::Transpose { expr },
            UnaryOp::Conj => ExprKind::Conj { expr },
            UnaryOp::RealPart => ExprKind::RealPart { expr },
            UnaryOp::ImagPart => ExprKind::ImagPart { expr },
            UnaryOp::Abs => ExprKind::Abs { expr },
            UnaryOp::Det => ExprKind::Det { expr },
            UnaryOp::Norm => ExprKind::Norm { expr },
            UnaryOp::Vectorize => ExprKind::Vectorize { expr },
        }
    }

    /// Builds a binary node; `split` is ignored for operators that cannot break (N8).
    pub fn binary(op: BinaryOp, left: Expr, right: Expr, split: bool) -> ExprKind {
        let left = Box::new(left);
        let right = Box::new(right);
        use ExprKind as K;
        match op {
            BinaryOp::Add => K::Add { left, right, split },
            BinaryOp::Sub => K::Sub { left, right, split },
            BinaryOp::Mul => K::Mul { left, right, split },
            BinaryOp::InlineDiv => K::InlineDiv { left, right, split },
            BinaryOp::Juxt => K::Juxt { left, right },
            BinaryOp::Cross => K::Cross { left, right },
            BinaryOp::Conv => K::Conv { left, right },
            BinaryOp::CircConv => K::CircConv { left, right },
            BinaryOp::Polar => K::Polar { left, right },
            BinaryOp::Div => K::Div { left, right },
            BinaryOp::Pow => K::Pow { left, right },
            BinaryOp::Eq => K::Eq { left, right },
            BinaryOp::Ne => K::Ne { left, right },
            BinaryOp::Lt => K::Lt { left, right },
            BinaryOp::Gt => K::Gt { left, right },
            BinaryOp::Le => K::Le { left, right },
            BinaryOp::Ge => K::Ge { left, right },
            BinaryOp::In => K::In { left, right },
            BinaryOp::And => K::And { left, right },
            BinaryOp::Or => K::Or { left, right },
            BinaryOp::Xor => K::Xor { left, right },
        }
    }

    /// The operator and operand of a unary node.
    pub fn as_unary(&self) -> Option<(UnaryOp, &Expr)> {
        use ExprKind as K;
        Some(match self {
            K::Neg { expr } => (UnaryOp::Neg, expr),
            K::Not { expr } => (UnaryOp::Not, expr),
            K::Factorial { expr } => (UnaryOp::Factorial, expr),
            K::Percent { expr } => (UnaryOp::Percent, expr),
            K::Permille { expr } => (UnaryOp::Permille, expr),
            K::Transpose { expr } => (UnaryOp::Transpose, expr),
            K::Conj { expr } => (UnaryOp::Conj, expr),
            K::RealPart { expr } => (UnaryOp::RealPart, expr),
            K::ImagPart { expr } => (UnaryOp::ImagPart, expr),
            K::Abs { expr } => (UnaryOp::Abs, expr),
            K::Det { expr } => (UnaryOp::Det, expr),
            K::Norm { expr } => (UnaryOp::Norm, expr),
            K::Vectorize { expr } => (UnaryOp::Vectorize, expr),
            _ => return None,
        })
    }

    pub fn as_unary_mut(&mut self) -> Option<(UnaryOp, &mut Box<Expr>)> {
        use ExprKind as K;
        Some(match self {
            K::Neg { expr } => (UnaryOp::Neg, expr),
            K::Not { expr } => (UnaryOp::Not, expr),
            K::Factorial { expr } => (UnaryOp::Factorial, expr),
            K::Percent { expr } => (UnaryOp::Percent, expr),
            K::Permille { expr } => (UnaryOp::Permille, expr),
            K::Transpose { expr } => (UnaryOp::Transpose, expr),
            K::Conj { expr } => (UnaryOp::Conj, expr),
            K::RealPart { expr } => (UnaryOp::RealPart, expr),
            K::ImagPart { expr } => (UnaryOp::ImagPart, expr),
            K::Abs { expr } => (UnaryOp::Abs, expr),
            K::Det { expr } => (UnaryOp::Det, expr),
            K::Norm { expr } => (UnaryOp::Norm, expr),
            K::Vectorize { expr } => (UnaryOp::Vectorize, expr),
            _ => return None,
        })
    }

    /// The operator, operands and split flag of a binary node.
    pub fn as_binary(&self) -> Option<(BinaryOp, &Expr, &Expr, bool)> {
        use ExprKind as K;
        Some(match self {
            K::Add { left, right, split } => (BinaryOp::Add, left, right, *split),
            K::Sub { left, right, split } => (BinaryOp::Sub, left, right, *split),
            K::Mul { left, right, split } => (BinaryOp::Mul, left, right, *split),
            K::InlineDiv { left, right, split } => (BinaryOp::InlineDiv, left, right, *split),
            K::Juxt { left, right } => (BinaryOp::Juxt, left, right, false),
            K::Cross { left, right } => (BinaryOp::Cross, left, right, false),
            K::Conv { left, right } => (BinaryOp::Conv, left, right, false),
            K::CircConv { left, right } => (BinaryOp::CircConv, left, right, false),
            K::Polar { left, right } => (BinaryOp::Polar, left, right, false),
            K::Div { left, right } => (BinaryOp::Div, left, right, false),
            K::Pow { left, right } => (BinaryOp::Pow, left, right, false),
            K::Eq { left, right } => (BinaryOp::Eq, left, right, false),
            K::Ne { left, right } => (BinaryOp::Ne, left, right, false),
            K::Lt { left, right } => (BinaryOp::Lt, left, right, false),
            K::Gt { left, right } => (BinaryOp::Gt, left, right, false),
            K::Le { left, right } => (BinaryOp::Le, left, right, false),
            K::Ge { left, right } => (BinaryOp::Ge, left, right, false),
            K::In { left, right } => (BinaryOp::In, left, right, false),
            K::And { left, right } => (BinaryOp::And, left, right, false),
            K::Or { left, right } => (BinaryOp::Or, left, right, false),
            K::Xor { left, right } => (BinaryOp::Xor, left, right, false),
            _ => return None,
        })
    }

    pub fn as_binary_mut(&mut self) -> Option<(BinaryOp, &mut Box<Expr>, &mut Box<Expr>)> {
        use ExprKind as K;
        Some(match self {
            K::Add { left, right, .. } => (BinaryOp::Add, left, right),
            K::Sub { left, right, .. } => (BinaryOp::Sub, left, right),
            K::Mul { left, right, .. } => (BinaryOp::Mul, left, right),
            K::InlineDiv { left, right, .. } => (BinaryOp::InlineDiv, left, right),
            K::Juxt { left, right } => (BinaryOp::Juxt, left, right),
            K::Cross { left, right } => (BinaryOp::Cross, left, right),
            K::Conv { left, right } => (BinaryOp::Conv, left, right),
            K::CircConv { left, right } => (BinaryOp::CircConv, left, right),
            K::Polar { left, right } => (BinaryOp::Polar, left, right),
            K::Div { left, right } => (BinaryOp::Div, left, right),
            K::Pow { left, right } => (BinaryOp::Pow, left, right),
            K::Eq { left, right } => (BinaryOp::Eq, left, right),
            K::Ne { left, right } => (BinaryOp::Ne, left, right),
            K::Lt { left, right } => (BinaryOp::Lt, left, right),
            K::Gt { left, right } => (BinaryOp::Gt, left, right),
            K::Le { left, right } => (BinaryOp::Le, left, right),
            K::Ge { left, right } => (BinaryOp::Ge, left, right),
            K::In { left, right } => (BinaryOp::In, left, right),
            K::And { left, right } => (BinaryOp::And, left, right),
            K::Or { left, right } => (BinaryOp::Or, left, right),
            K::Xor { left, right } => (BinaryOp::Xor, left, right),
            _ => return None,
        })
    }

    /// True for `∑ ∏ ∫ ⅆ ∂ \lim`.
    pub fn is_big_op(&self) -> bool {
        matches!(
            self,
            ExprKind::Sum { .. }
                | ExprKind::Prod { .. }
                | ExprKind::Integral { .. }
                | ExprKind::Deriv { .. }
                | ExprKind::Partial { .. }
                | ExprKind::Gradient { .. }
                | ExprKind::Limit { .. }
        )
    }
}

// ---------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------

/// Left side of `:=`, `≡`, `←` or of an inline argument definition (math-syntax 7.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    #[serde(default)]
    pub span: Span,
    #[serde(flatten)]
    pub kind: TargetKind,
}

impl Target {
    pub fn new(kind: TargetKind, span: Span) -> Target {
        Target { span, kind }
    }

    pub fn synth(kind: TargetKind) -> Target {
        Target {
            span: Span::default(),
            kind,
        }
    }

    /// True for an unfilled target or function-head slot in an editable draft.
    pub fn has_placeholder(&self) -> bool {
        let empty = |name: &Name| name.segments.iter().all(|segment| segment.text.is_empty());
        match &self.kind {
            TargetKind::Ident { name } => empty(name),
            TargetKind::Index { base, .. }
            | TargetKind::Column { base, .. }
            | TargetKind::Row { base, .. } => base.has_placeholder(),
            TargetKind::Paren { target } => target.has_placeholder(),
            TargetKind::Destructure { cells, .. } => cells.iter().any(Target::has_placeholder),
            TargetKind::FunctionHead { name, params } => {
                empty(&name.name) || params.iter().any(|p| empty(&p.name))
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TargetKind {
    Ident {
        name: Name,
    },
    Index {
        base: Box<Target>,
        indices: Vec<Expr>,
    },
    Column {
        base: Box<Target>,
        index: Box<Expr>,
    },
    Row {
        base: Box<Target>,
        index: Box<Expr>,
    },
    Paren {
        target: Box<Target>,
    },
    /// `[a, b; c, d]`: cells in row-major order.
    Destructure {
        rows: usize,
        cols: usize,
        cells: Vec<Target>,
    },
    /// `f(x, y)`: a worksheet definition (`f(x, y) := e`) or a program's local function
    /// definition (`f(x, y) ← e`, compatibility ).
    FunctionHead {
        name: Ident,
        params: Vec<Ident>,
    },
}

// ---------------------------------------------------------------------------------------
// Region statements
// ---------------------------------------------------------------------------------------

/// The content of a math region (math-syntax section 7 and 11.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Statement {
    #[serde(default)]
    pub span: Span,
    #[serde(flatten)]
    pub kind: StatementKind,
}

impl Statement {
    pub fn new(kind: StatementKind, span: Span) -> Statement {
        Statement { span, kind }
    }

    pub fn synth(kind: StatementKind) -> Statement {
        Statement {
            span: Span::default(),
            kind,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StatementKind {
    /// `t := e`, optionally with an evaluation tail (`t := e =`, `t := e →[k]`).
    /// `rhs` may be a `Range` or a `Program`.
    Define {
        target: Target,
        rhs: Expr,
        tail: Option<Tail>,
    },
    /// `t ≡ e`.
    GlobalDefine { target: Target, rhs: Expr },
    /// `e =` or `e = … unit`.
    Evaluate { expr: Expr, unit: Option<Expr> },
    /// `e →[k, a]…`.
    Symbolic {
        expr: Expr,
        keywords: Vec<KeywordGroup>,
    },
    /// A bare expression, displayed and not evaluated.
    ExprRegion { expr: Expr },
    /// An input table: `grid` is a matrix whose first row names the
    /// columns, whose second row holds their units when `units` is set, and whose other rows
    /// hold the values. Each named column defines a column vector.
    Table { units: bool, grid: Expr },
    /// A `julia` region: packages, imported functions and free Julia code.
    /// Not math syntax: it has no text form and is only created by the YAML reader.
    Julia { block: JuliaBlock },
    /// A solve block: constraint lines and the statement that
    /// holds the solving call (`Find(x, y) =`, `s := Minerr(x)`). Like `Julia`, it has no
    /// math text form and is created by the YAML reader.
    Solve {
        constraints: Vec<Expr>,
        call: Box<Statement>,
    },
}

/// The content of a `julia` region.
///
/// `PartialEq` only: the size of the box (`size`) is a float pair, and the box is display only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JuliaBlock {
    /// Whether the block is evaluated: a stopped block runs
    /// no code and exports no name. A file without the field plays its blocks, and a block
    /// inserted from the ribbon starts stopped.
    #[serde(default = "playing_by_default")]
    pub playing: bool,
    /// The size in points of the box the block is drawn in:
    /// width and height, both finite and positive. `None` is a block without a stored box, which
    /// grows with its header and its code as it always did (a file without the field is unchanged).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<(f64, f64)>,
    /// Packages loaded with `using` (module names, validated).
    #[serde(default)]
    pub using: Vec<String>,
    /// Imported functions: worksheet name, package, function.
    #[serde(default)]
    pub imports: Vec<JuliaImportDecl>,
    /// Free Julia source (top-level statements), if any.
    #[serde(default)]
    pub code: Option<String>,
    /// Extra names that the code makes visible to math regions, in addition to the
    /// ones detected from top-level definitions.
    #[serde(default)]
    pub defines: Vec<String>,
}

/// The default of [`JuliaBlock::playing`]: a block whose block carries no `playing` key plays.
fn playing_by_default() -> bool {
    true
}

impl Default for JuliaBlock {
    fn default() -> Self {
        JuliaBlock {
            playing: true,
            size: None,
            using: Vec::new(),
            imports: Vec::new(),
            code: None,
            defines: Vec::new(),
        }
    }
}

/// `lqr: ControlSystems.lqr` in the `import` map of a `julia` region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JuliaImportDecl {
    pub name: String,
    pub package: String,
    pub function: String,
}

/// Evaluation tail of a definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Tail {
    Eval { unit: Option<Expr> },
    Sym { keywords: Vec<KeywordGroup> },
}

/// `[keyword, arg, …]` after `→`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeywordGroup {
    pub keyword: Ident,
    pub args: Vec<Expr>,
    #[serde(default)]
    pub span: Span,
}

// ---------------------------------------------------------------------------------------
// Program statements
// ---------------------------------------------------------------------------------------

/// A statement inside a program (math-syntax 8.2 and 11.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stmt {
    #[serde(default)]
    pub span: Span,
    #[serde(flatten)]
    pub kind: StmtKind,
}

impl Stmt {
    pub fn new(kind: StmtKind, span: Span) -> Stmt {
        Stmt { span, kind }
    }

    pub fn synth(kind: StmtKind) -> Stmt {
        Stmt {
            span: Span::default(),
            kind,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StmtKind {
    /// `t ← e`; `rhs` may be a `Program`.
    LocalDef {
        target: Target,
        rhs: Expr,
    },
    /// `if` with `else if` or `also if` branches and an optional `else` (N6).
    If {
        branches: Vec<Branch>,
        #[serde(rename = "else")]
        else_body: Option<Vec<Stmt>>,
    },
    /// `for i ∈ source`; `source` may be a `Range`.
    For {
        var: Ident,
        source: Expr,
        body: Vec<Stmt>,
    },
    While {
        cond: Expr,
        body: Vec<Stmt>,
    },
    Break,
    Continue,
    Return {
        expr: Expr,
    },
    Try {
        body: Vec<Stmt>,
        handler: Vec<Stmt>,
    },
    ExprStmt {
        expr: Expr,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BranchKind {
    If,
    ElseIf,
    AlsoIf,
}

/// One `if c` / `else if c` / `also if c` branch with its body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Branch {
    pub kind: BranchKind,
    pub cond: Expr,
    pub body: Vec<Stmt>,
    #[serde(default)]
    pub span: Span,
}
