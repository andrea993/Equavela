//! Hand-written recursive-descent parser for sheet math text (math-syntax section 12).

use super::error::{join_alternatives, ParseError};
use super::lexer::{lex, Tok, Token};
use super::prec::{fits, Pos};
use crate::ast::*;

type PResult<T> = Result<T, ParseError>;

/// Parses the content of a math region: a definition, global definition, evaluation
/// (with optional unit override), symbolic evaluation, or bare expression. Block programs
/// and equation breaks may span several lines.
pub fn parse_statement(src: &str) -> Result<Statement, ParseError> {
    if let Some(table) = table_statement(src)? {
        return Ok(table);
    }
    let mut p = Parser::new(src)?;
    let s = p.region_statement()?;
    p.expect_end_of_input()?;
    Ok(s)
}

/// `table:[…]` and `table units:[…]`: the rest is a matrix, parsed
/// with the prefix blanked out so that spans keep their place in the text.
fn table_statement(src: &str) -> Result<Option<Statement>, ParseError> {
    let trimmed = src.trim_start();
    let lead = src.len() - trimmed.len();
    let (units, prefix) = if trimmed.starts_with("table units:") {
        (true, "table units:")
    } else if trimmed.starts_with("table:") && !trimmed.starts_with("table:=") {
        (false, "table:")
    } else {
        return Ok(None);
    };
    let blanked = format!(
        "{}{}",
        " ".repeat(lead + prefix.len()),
        &trimmed[prefix.len()..]
    );
    let grid = parse_expression(&blanked)?;
    let rows = match &grid.kind {
        ExprKind::Matrix { rows, .. } => *rows,
        _ => {
            return Err(ParseError::at(
                src,
                Span::new(lead + prefix.len(), src.len()),
                "a table is written `table:[names; values]`",
            ))
        }
    };
    if rows < if units { 3 } else { 2 } {
        return Err(ParseError::at(
            src,
            Span::new(lead + prefix.len(), src.len()),
            "a table needs a row of names, a row of units when shown, and at least one row of values",
        ));
    }
    let span = Span::new(lead, src.len());
    Ok(Some(Statement::new(
        StatementKind::Table { units, grid },
        span,
    )))
}

/// Parses an indented block of program statements (the body of a block program, as stored
/// in a YAML block scalar), one statement per line. The first line sets the indentation.
pub fn parse_program_block(src: &str) -> Result<Vec<Stmt>, ParseError> {
    let mut p = Parser::new(src)?;
    let indent = p.stmt_indent;
    let body = p.block_lines(indent)?;
    p.expect_end_of_input()?;
    Ok(body)
}

/// Parses a single expression (for saved results and other expression-only fields).
pub fn parse_expression(src: &str) -> Result<Expr, ParseError> {
    let mut p = Parser::new(src)?;
    let e = p.expression()?;
    p.expect_end_of_input()?;
    Ok(e)
}

/// Parses a comma-separated list of call arguments (`a, b`), the clipboard form of a run of
/// arguments. The inverse of `print_arguments`.
pub fn parse_arguments(src: &str) -> Result<Vec<Arg>, ParseError> {
    let mut p = Parser::new(src)?;
    let args = p.argument_list()?;
    p.expect_end_of_input()?;
    Ok(args)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Closer {
    Bar,
    DBar,
}

/// Whether an index subscript may be a range and, when it may not,
/// which message says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubscriptRange {
    /// A subscript of the index of an expression: `v[a..b]`, `M[a..b, c..d]`.
    Allowed,
    /// The index of an assignment target, which takes an expression (section 7.3).
    NotInTarget,
}

/// The error of a range in the suffix of an assignment target (section 7.3).
const RANGE_NOT_IN_TARGET: &str = "a range is not allowed in an assignment target";

struct Parser<'s> {
    src: &'s str,
    toks: Vec<Token>,
    pos: usize,
    /// The innermost open `|…|` or `‖…‖` not hidden by brackets (disambiguation rule 5).
    closer: Option<Closer>,
    /// An assignment target met a range: the region is then a definition whose left
    /// side the language does not take, and the message says that instead of "invalid left
    /// side of a definition".
    range_in_target: bool,
    /// Indentation of the first line of the statement being parsed (equation breaks).
    stmt_indent: usize,
}

#[derive(Clone, Copy)]
struct Saved {
    pos: usize,
    closer: Option<Closer>,
    stmt_indent: usize,
}

fn describe(tok: &Tok, src_text: &str) -> String {
    match tok {
        Tok::Eof => "end of input".to_string(),
        Tok::Newline(_) => "line break".to_string(),
        Tok::Num(_) => format!("number `{src_text}`"),
        Tok::Imag(..) => format!("imaginary number `{src_text}`"),
        Tok::Str(_) => "string".to_string(),
        Tok::Ident(..) => format!("name `{src_text}`"),
        _ => format!("`{src_text}`"),
    }
}

impl<'s> Parser<'s> {
    fn new(src: &'s str) -> PResult<Parser<'s>> {
        let lexed = lex(src)?;
        Ok(Parser {
            src,
            toks: lexed.tokens,
            pos: 0,
            closer: None,
            range_in_target: false,
            stmt_indent: lexed.first_indent,
        })
    }

    // ----------------------------------------------------------------- token helpers

    fn peek(&self) -> &Token {
        &self.toks[self.pos]
    }

    fn peek_n(&self, n: usize) -> &Token {
        &self.toks[(self.pos + n).min(self.toks.len() - 1)]
    }

    fn at(&self, tok: &Tok) -> bool {
        &self.peek().tok == tok
    }

    fn bump(&mut self) -> Token {
        let t = self.toks[self.pos].clone();
        if !matches!(t.tok, Tok::Eof) {
            self.pos += 1;
        }
        t
    }

    fn eat(&mut self, tok: &Tok) -> bool {
        if self.at(tok) {
            self.bump();
            true
        } else {
            false
        }
    }

    fn prev_end(&self) -> usize {
        if self.pos == 0 {
            0
        } else {
            self.toks[self.pos - 1].span.end
        }
    }

    fn start(&self) -> usize {
        self.peek().span.start
    }

    fn span_from(&self, start: usize) -> Span {
        Span::new(start, self.prev_end().max(start))
    }

    fn save(&self) -> Saved {
        Saved {
            pos: self.pos,
            closer: self.closer,
            stmt_indent: self.stmt_indent,
        }
    }

    fn restore(&mut self, s: Saved) {
        self.pos = s.pos;
        self.closer = s.closer;
        self.stmt_indent = s.stmt_indent;
    }

    fn found(&self) -> String {
        let t = self.peek();
        describe(&t.tok, &self.src[t.span.range()])
    }

    fn err_expected(&self, expected: &[&str]) -> ParseError {
        let expected: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
        let found = self.found();
        let msg = format!("expected {}, found {}", join_alternatives(&expected), found);
        ParseError::new(self.src, self.peek().span, msg, expected, Some(found))
    }

    fn err_here(&self, msg: impl Into<String>) -> ParseError {
        let found = self.found();
        ParseError::new(self.src, self.peek().span, msg, Vec::new(), Some(found))
    }

    fn err_span(&self, span: Span, msg: impl Into<String>) -> ParseError {
        ParseError::at(self.src, span, msg)
    }

    fn expect(&mut self, tok: Tok, what: &str) -> PResult<Token> {
        if self.at(&tok) {
            Ok(self.bump())
        } else {
            Err(self.err_expected(&[what]))
        }
    }

    /// Is the token `n` ahead the statement keyword `word` (bare, followed by a delimiter)?
    fn is_kw_at(&self, n: usize, word: &str) -> bool {
        let t = self.peek_n(n);
        t.delim_after && matches!(&t.tok, Tok::Ident(_, Some(b)) if b == word)
    }

    fn is_kw(&self, word: &str) -> bool {
        self.is_kw_at(0, word)
    }

    fn is_bare_word(&self, n: usize, word: &str) -> bool {
        matches!(&self.peek_n(n).tok, Tok::Ident(_, Some(b)) if b == word)
    }

    /// `program` followed by the end of the line: a block program.
    fn at_block_program(&self) -> bool {
        self.is_bare_word(0, "program") && matches!(self.peek_n(1).tok, Tok::Newline(_) | Tok::Eof)
    }

    fn with_brackets<T>(&mut self, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
        let saved = self.closer.take();
        let r = f(self);
        self.closer = saved;
        r
    }

    fn expect_end_of_input(&mut self) -> PResult<()> {
        match self.peek().tok {
            Tok::Eof => Ok(()),
            Tok::Newline(_) => Err(self.err_here(
                "unexpected line break (only programs and equation breaks span several lines)",
            )),
            _ => Err(self.unexpected_after_statement()),
        }
    }

    fn unexpected_after_statement(&self) -> ParseError {
        match self.peek().tok {
            Tok::DotDot => self.err_here(
                "a range is allowed only as the right side of a worksheet-level definition, in a `for` header, in a ∑/∏/∫ binder, as the index of a ⟨…⟩, ⟪…⟫ or [ ] operator or as a function argument",
            ),
            // The left side failed only because of a range: say that, not that the
            // left side is not a target at all.
            Tok::ColonEq | Tok::Equiv | Tok::LArrow if self.range_in_target => {
                self.err_here(RANGE_NOT_IN_TARGET)
            }
            Tok::ColonEq | Tok::Equiv => self.err_here(
                "invalid left side of a definition (expected a name, an indexed name, a destructuring matrix or a function head)",
            ),
            Tok::LArrow => self.err_here(
                "`←` is allowed only after a target in a program statement, a call argument or a parenthesised operand `(target ← e)`",
            ),
            Tok::RParen | Tok::RBrack | Tok::RBrace | Tok::RAngle | Tok::RDAngle => {
                let f = self.found();
                self.err_here(format!("unmatched {f}"))
            }
            _ => {
                let f = self.found();
                self.err_here(format!("unexpected {f}"))
            }
        }
    }

    // ----------------------------------------------------------------- statements

    fn region_statement(&mut self) -> PResult<Statement> {
        let start = self.start();
        self.range_in_target = false;
        let saved = self.save();
        if let Ok(target) = self.target() {
            if matches!(self.peek().tok, Tok::ColonEq | Tok::Equiv) {
                let global = self.bump().tok == Tok::Equiv;
                let (rhs, block) = self.define_rhs()?;
                if global {
                    if matches!(self.peek().tok, Tok::Equals | Tok::Arrow) {
                        return Err(
                            self.err_here("a global definition cannot have an evaluation tail")
                        );
                    }
                    return Ok(Statement::new(
                        StatementKind::GlobalDefine { target, rhs },
                        self.span_from(start),
                    ));
                }
                let tail = if block { None } else { self.tail()? };
                return Ok(Statement::new(
                    StatementKind::Define { target, rhs, tail },
                    self.span_from(start),
                ));
            }
        }
        self.restore(saved);
        let expr = self.expression()?;
        if matches!(self.peek().tok, Tok::ColonEq | Tok::Equiv) {
            // A definition whose left side is not something that can be defined: the region is
            // kept as written and its calculation reports the left side.
            let target = Target::new(
                TargetKind::Invalid {
                    expr: Box::new(expr),
                },
                self.span_from(start),
            );
            let global = self.bump().tok == Tok::Equiv;
            let (rhs, block) = self.define_rhs()?;
            if global {
                return Ok(Statement::new(
                    StatementKind::GlobalDefine { target, rhs },
                    self.span_from(start),
                ));
            }
            let tail = if block { None } else { self.tail()? };
            return Ok(Statement::new(
                StatementKind::Define { target, rhs, tail },
                self.span_from(start),
            ));
        }
        let kind = match self.tail()? {
            Some(Tail::Eval { unit }) => StatementKind::Evaluate { expr, unit },
            Some(Tail::Sym { keywords }) => StatementKind::Symbolic { expr, keywords },
            None => StatementKind::ExprRegion { expr },
        };
        Ok(Statement::new(kind, self.span_from(start)))
    }

    /// Right side of `:=` / `≡`; the flag is true for a block program.
    fn define_rhs(&mut self) -> PResult<(Expr, bool)> {
        if self.at_block_program() {
            let e = self.block_program()?;
            return Ok((e, true));
        }
        Ok((self.range_or_expr()?, false))
    }

    fn block_program(&mut self) -> PResult<Expr> {
        let start = self.start();
        self.bump(); // `program`
        let indent = self.stmt_indent;
        let body = self.block_body(indent, "`program`")?;
        self.stmt_indent = indent;
        Ok(Expr::new(ExprKind::Program { body }, self.span_from(start)))
    }

    fn tail(&mut self) -> PResult<Option<Tail>> {
        match self.peek().tok {
            Tok::Equals => {
                self.bump();
                let unit = if self.eat(&Tok::Ellipsis) {
                    if matches!(self.peek().tok, Tok::Eof | Tok::Newline(_)) {
                        return Err(self.err_expected(&["a unit after `…`"]));
                    }
                    Some(self.expression()?)
                } else {
                    None
                };
                Ok(Some(Tail::Eval { unit }))
            }
            Tok::Arrow => {
                self.bump();
                let mut keywords = Vec::new();
                while self.at(&Tok::LBrack) {
                    let start = self.start();
                    self.bump();
                    let group = self.with_brackets(|p| {
                        let keyword = p.binder("a symbolic keyword")?;
                        let mut args = Vec::new();
                        while p.eat(&Tok::Comma) {
                            args.push(p.expression()?);
                        }
                        p.expect(Tok::RBrack, "`,` or `]`")?;
                        Ok((keyword, args))
                    })?;
                    keywords.push(KeywordGroup {
                        keyword: group.0,
                        args: group.1,
                        span: self.span_from(start),
                    });
                }
                Ok(Some(Tail::Sym { keywords }))
            }
            _ => Ok(None),
        }
    }

    fn ident(&mut self, what: &str) -> PResult<Ident> {
        match &self.peek().tok {
            Tok::Ident(name, _) => {
                let name = name.clone();
                let t = self.bump();
                Ok(Ident { name, span: t.span })
            }
            _ => Err(self.err_expected(&[what])),
        }
    }

    fn binder(&mut self, what: &str) -> PResult<Ident> {
        if self.at(&Tok::Placeholder) {
            let token = self.bump();
            Ok(Ident {
                name: Name::plain(""),
                span: token.span,
            })
        } else {
            self.ident(what)
        }
    }

    // ----------------------------------------------------------------- targets

    fn target(&mut self) -> PResult<Target> {
        if self.at(&Tok::LBrack) {
            return self.destructure();
        }
        if matches!(self.peek().tok, Tok::Ident(..) | Tok::Placeholder)
            && self.peek_n(1).tok == Tok::LParen
            && !self.peek_n(1).space_before
        {
            let start = self.start();
            let name = self.binder("a function name")?;
            self.bump(); // `(`
            let mut params = Vec::new();
            if !self.eat(&Tok::RParen) {
                loop {
                    params.push(self.binder("a parameter name")?);
                    if self.eat(&Tok::Comma) {
                        continue;
                    }
                    self.expect(Tok::RParen, "`,` or `)`")?;
                    break;
                }
            }
            return Ok(Target::new(
                TargetKind::FunctionHead { name, params },
                self.span_from(start),
            ));
        }
        self.lvalue()
    }

    fn destructure(&mut self) -> PResult<Target> {
        let start = self.start();
        self.bump(); // `[`
        let (rows, cols, cells) = self.with_brackets(|p| {
            let mut cells = Vec::new();
            let mut rows = 0;
            let mut cols = 0;
            loop {
                let row_start = p.start();
                let mut n = 0;
                loop {
                    cells.push(p.destructure_cell()?);
                    n += 1;
                    if !p.eat(&Tok::Comma) {
                        break;
                    }
                }
                if rows == 0 {
                    cols = n;
                } else if n != cols {
                    return Err(p.err_span(
                        p.span_from(row_start),
                        format!(
                            "destructuring row {} has {n} cells, expected {cols}",
                            rows + 1
                        ),
                    ));
                }
                rows += 1;
                if !p.eat(&Tok::Semi) {
                    break;
                }
            }
            p.expect(Tok::RBrack, "`,`, `;` or `]`")?;
            Ok((rows, cols, cells))
        })?;
        Ok(Target::new(
            TargetKind::Destructure { rows, cols, cells },
            self.span_from(start),
        ))
    }

    /// A cell of a destructuring matrix, or the target of an inline argument definition: an
    /// lvalue, or a destructuring matrix whose cells unpack a nested array.
    fn destructure_cell(&mut self) -> PResult<Target> {
        if self.at(&Tok::LBrack) {
            self.destructure()
        } else {
            self.lvalue()
        }
    }

    fn lvalue(&mut self) -> PResult<Target> {
        let start = self.start();
        let mut t = match &self.peek().tok {
            Tok::Ident(name, _) => {
                let name = name.clone();
                self.bump();
                Target::new(TargetKind::Ident { name }, self.span_from(start))
            }
            Tok::Placeholder => {
                self.bump();
                Target::new(
                    TargetKind::Ident {
                        name: Name::plain(""),
                    },
                    self.span_from(start),
                )
            }
            Tok::LParen => {
                self.bump();
                let inner = self.with_brackets(|p| p.lvalue())?;
                self.expect(Tok::RParen, "`)`")?;
                Target::new(
                    TargetKind::Paren {
                        target: Box::new(inner),
                    },
                    self.span_from(start),
                )
            }
            _ => return Err(self.err_expected(&["a name"])),
        };
        loop {
            let tk = self.peek();
            if tk.space_before {
                break;
            }
            let kind = match tk.tok {
                Tok::LBrack => {
                    let indices = self.index_suffix(SubscriptRange::NotInTarget)?;
                    TargetKind::Index {
                        base: Box::new(t),
                        indices,
                    }
                }
                Tok::LAngle => {
                    let index = self.angle_suffix(Tok::RAngle, "`⟩`", false)?;
                    TargetKind::Column {
                        base: Box::new(t),
                        index: Box::new(index),
                    }
                }
                Tok::LDAngle => {
                    let index = self.angle_suffix(Tok::RDAngle, "`⟫`", false)?;
                    TargetKind::Row {
                        base: Box::new(t),
                        index: Box::new(index),
                    }
                }
                // `Vᵀ := e` defines `V` as `eᵀ`; the transpose ends the target.
                Tok::Transpose => {
                    self.bump();
                    return Ok(Target::new(
                        TargetKind::Transpose {
                            target: Box::new(t),
                        },
                        self.span_from(start),
                    ));
                }
                _ => break,
            };
            t = Target::new(kind, self.span_from(start));
        }
        Ok(t)
    }

    /// `[i]`, `[i, j]`, and a two-bound range as either subscript: `v[a..b]`, `M[a..b, c..d]`
    ///. A subscript is one or two of these, never a third. The comma separates the
    /// subscripts, so the step form of a range is not written inside an index.
    fn index_suffix(&mut self, ranges: SubscriptRange) -> PResult<Vec<Expr>> {
        self.bump(); // `[`
        self.with_brackets(|p| {
            let first = p.index_subscript(ranges)?;
            let mut indices = vec![first];
            if p.at(&Tok::Comma) {
                p.bump();
                indices.push(p.index_subscript(ranges)?);
            }
            if p.at(&Tok::Comma) {
                return Err(p.err_here("an index has one or two subscripts"));
            }
            p.expect(Tok::RBrack, "`,` or `]`")?;
            Ok(indices)
        })
    }

    /// One subscript of an index: an expression, or a two-bound range where the index takes
    /// one.
    fn index_subscript(&mut self, ranges: SubscriptRange) -> PResult<Expr> {
        let start = self.start();
        let first = self.expression()?;
        if !self.at(&Tok::DotDot) {
            return Ok(first);
        }
        match ranges {
            SubscriptRange::Allowed => {}
            SubscriptRange::NotInTarget => {
                self.range_in_target = true;
                return Err(self.err_here(RANGE_NOT_IN_TARGET));
            }
        }
        if !fits(Pos::AddExpr, &first) {
            return Err(self.err_span(
                first.span,
                "a range bound must be an arithmetic expression (use parentheses)",
            ));
        }
        self.bump(); // `..`
        let last = self.add_expr()?;
        Ok(Expr::new(
            ExprKind::Range {
                first: Box::new(first),
                second: None,
                last: Box::new(last),
            },
            self.span_from(start),
        ))
    }

    /// The content of `⟨ ⟩` or `⟪ ⟫`: a range or an expression in the index
    /// of an expression, an expression alone in the suffix of a target.
    fn angle_suffix(&mut self, close: Tok, what: &str, ranges: bool) -> PResult<Expr> {
        self.bump();
        self.with_brackets(|p| {
            let e = if ranges {
                p.range_or_expr()?
            } else {
                let e = p.expression()?;
                if p.at(&Tok::DotDot) {
                    p.range_in_target = true;
                    return Err(p.err_here(RANGE_NOT_IN_TARGET));
                }
                e
            };
            p.expect(close, what)?;
            Ok(e)
        })
    }

    // ----------------------------------------------------------------- programs, block form

    /// `NEWLINE INDENT statement-line { statement-line } DEDENT` after a header.
    fn block_body(&mut self, parent_indent: usize, after: &str) -> PResult<Vec<Stmt>> {
        match self.peek().tok {
            Tok::Newline(ind) if ind > parent_indent => {
                self.bump();
                self.block_lines(ind)
            }
            Tok::Newline(_) => {
                let next = self.peek_n(1).span;
                Err(self.err_span(next, format!("expected an indented block after {after}")))
            }
            _ => {
                Err(self
                    .err_expected(&[&format!("a line break and an indented block after {after}")]))
            }
        }
    }

    fn block_lines(&mut self, ind: usize) -> PResult<Vec<Stmt>> {
        let mut body = Vec::new();
        loop {
            self.stmt_indent = ind;
            body.push(self.block_statement(ind)?);
            match self.peek().tok {
                Tok::Newline(i) if i == ind => {
                    self.bump();
                }
                Tok::Newline(i) if i > ind => {
                    let next = self.peek_n(1).span;
                    return Err(self.err_span(next, "unexpected indentation"));
                }
                Tok::Newline(_) | Tok::Eof => break,
                _ => return Err(self.unexpected_after_statement()),
            }
        }
        self.stmt_indent = ind;
        Ok(body)
    }

    fn block_statement(&mut self, ind: usize) -> PResult<Stmt> {
        let start = self.start();
        let kind = if self.is_kw("if") {
            self.block_if(ind)?
        } else if self.is_kw("for") {
            self.bump();
            let var = self.binder("a loop variable")?;
            self.expect(Tok::In, "`∈`")?;
            let source = self.range_or_expr()?;
            let body = self.block_body(ind, "`for`")?;
            StmtKind::For { var, source, body }
        } else if self.is_kw("while") {
            self.bump();
            let cond = self.expression()?;
            let body = self.block_body(ind, "`while`")?;
            StmtKind::While { cond, body }
        } else if self.is_kw("try") {
            self.bump();
            let body = self.block_body(ind, "`try`")?;
            self.stmt_indent = ind;
            let ok = matches!(self.peek().tok, Tok::Newline(i) if i == ind)
                && self.is_kw_at(1, "on")
                && self.is_bare_word(2, "error");
            if !ok {
                let span = match self.peek().tok {
                    Tok::Newline(i) if i == ind => self.peek_n(1).span,
                    _ => self.peek().span,
                };
                return Err(self.err_span(span, "expected `on error` after the body of `try`"));
            }
            self.bump();
            self.bump();
            self.bump();
            let handler = self.block_body(ind, "`on error`")?;
            StmtKind::Try { body, handler }
        } else if let Some(k) = self.simple_keyword()? {
            k
        } else {
            self.simple_statement(true)?
        };
        Ok(Stmt::new(kind, self.span_from(start)))
    }

    /// `break`, `continue`, `return e`, or an error for an orphan continuation keyword.
    fn simple_keyword(&mut self) -> PResult<Option<StmtKind>> {
        if self.is_kw("break") {
            self.bump();
            return Ok(Some(StmtKind::Break));
        }
        if self.is_kw("continue") {
            self.bump();
            return Ok(Some(StmtKind::Continue));
        }
        if self.is_kw("return") {
            self.bump();
            if matches!(
                self.peek().tok,
                Tok::Newline(_) | Tok::Eof | Tok::Semi | Tok::RBrace
            ) {
                return Err(self.err_expected(&["an expression after `return`"]));
            }
            let expr = self.expression()?;
            return Ok(Some(StmtKind::Return { expr }));
        }
        if self.is_kw("else") {
            return Err(self.err_here("`else` without a matching `if`"));
        }
        if self.is_kw("also") {
            return Err(self.err_here("`also if` without a matching `if`"));
        }
        if self.is_kw("on") {
            return Err(self.err_here("`on error` without a matching `try`"));
        }
        Ok(None)
    }

    fn simple_statement(&mut self, block: bool) -> PResult<StmtKind> {
        let saved = self.save();
        self.range_in_target = false;
        // `target` is `destructure | lvalue | function-head`: a function head is a local
        // function definition.
        if let Ok(target) = self.target() {
            if self.eat(&Tok::LArrow) {
                let rhs = if block && self.at_block_program() {
                    self.block_program()?
                } else {
                    self.expression()?
                };
                return Ok(StmtKind::LocalDef { target, rhs });
            }
        }
        self.restore(saved);
        let expr = self.expression()?;
        if self.at(&Tok::LArrow) {
            return Err(self.err_here(
                "invalid target of `←` (expected a name, an indexed name, a destructuring matrix \
                 or a function head)",
            ));
        }
        Ok(StmtKind::ExprStmt { expr })
    }

    fn block_if(&mut self, ind: usize) -> PResult<StmtKind> {
        let start = self.start();
        self.bump(); // `if`
        let cond = self.expression()?;
        let body = self.block_body(ind, "`if`")?;
        let mut branches = vec![Branch {
            kind: BranchKind::If,
            cond,
            body,
            span: self.span_from(start),
        }];
        let mut else_body = None;
        loop {
            self.stmt_indent = ind;
            let same_line = matches!(self.peek().tok, Tok::Newline(i) if i == ind);
            if !(same_line && (self.is_kw_at(1, "else") || self.is_kw_at(1, "also"))) {
                break;
            }
            self.bump(); // newline
            let bstart = self.start();
            if self.is_kw("else") {
                self.bump();
                if self.is_kw("if") {
                    self.bump();
                    self.check_branch_kind(&branches, BranchKind::ElseIf, bstart)?;
                    let cond = self.expression()?;
                    let body = self.block_body(ind, "`else if`")?;
                    branches.push(Branch {
                        kind: BranchKind::ElseIf,
                        cond,
                        body,
                        span: self.span_from(bstart),
                    });
                } else {
                    else_body = Some(self.block_body(ind, "`else`")?);
                    break;
                }
            } else {
                self.bump(); // `also`
                if !self.is_kw("if") {
                    return Err(self.err_expected(&["`if` after `also`"]));
                }
                self.bump();
                self.check_branch_kind(&branches, BranchKind::AlsoIf, bstart)?;
                let cond = self.expression()?;
                let body = self.block_body(ind, "`also if`")?;
                branches.push(Branch {
                    kind: BranchKind::AlsoIf,
                    cond,
                    body,
                    span: self.span_from(bstart),
                });
            }
        }
        self.stmt_indent = ind;
        Ok(StmtKind::If {
            branches,
            else_body,
        })
    }

    fn check_branch_kind(
        &self,
        branches: &[Branch],
        kind: BranchKind,
        start: usize,
    ) -> PResult<()> {
        if let Some(prev) = branches.get(1) {
            if prev.kind != kind {
                return Err(self.err_span(
                    self.span_from(start),
                    "`else if` and `also if` cannot be mixed in one conditional",
                ));
            }
        }
        Ok(())
    }

    // ----------------------------------------------------------------- programs, inline form

    fn inline_program(&mut self) -> PResult<Expr> {
        let start = self.start();
        self.bump(); // `program`
        let body = self.inline_body("`program`")?;
        Ok(Expr::new(ExprKind::Program { body }, self.span_from(start)))
    }

    fn inline_body(&mut self, after: &str) -> PResult<Vec<Stmt>> {
        if !self.at(&Tok::LBrace) {
            return Err(self.err_expected(&[&format!("`{{` after {after}")]));
        }
        self.bump();
        self.with_brackets(|p| {
            let mut body = Vec::new();
            loop {
                if p.at(&Tok::RBrace) {
                    return Err(p.err_expected(&["a statement"]));
                }
                body.push(p.inline_statement()?);
                if p.eat(&Tok::Semi) {
                    continue;
                }
                p.expect(Tok::RBrace, "`;` or `}`")?;
                break;
            }
            Ok(body)
        })
    }

    fn inline_statement(&mut self) -> PResult<Stmt> {
        let start = self.start();
        let kind = if self.is_kw("if") {
            let bstart = self.start();
            self.bump();
            let cond = self.expression()?;
            let body = self.inline_body("the condition of `if`")?;
            let mut branches = vec![Branch {
                kind: BranchKind::If,
                cond,
                body,
                span: self.span_from(bstart),
            }];
            let mut else_body = None;
            loop {
                let bstart = self.start();
                if self.is_kw("else") {
                    self.bump();
                    if self.is_kw("if") {
                        self.bump();
                        self.check_branch_kind(&branches, BranchKind::ElseIf, bstart)?;
                        let cond = self.expression()?;
                        let body = self.inline_body("the condition of `else if`")?;
                        branches.push(Branch {
                            kind: BranchKind::ElseIf,
                            cond,
                            body,
                            span: self.span_from(bstart),
                        });
                    } else {
                        else_body = Some(self.inline_body("`else`")?);
                        break;
                    }
                } else if self.is_kw("also") {
                    self.bump();
                    if !self.is_kw("if") {
                        return Err(self.err_expected(&["`if` after `also`"]));
                    }
                    self.bump();
                    self.check_branch_kind(&branches, BranchKind::AlsoIf, bstart)?;
                    let cond = self.expression()?;
                    let body = self.inline_body("the condition of `also if`")?;
                    branches.push(Branch {
                        kind: BranchKind::AlsoIf,
                        cond,
                        body,
                        span: self.span_from(bstart),
                    });
                } else {
                    break;
                }
            }
            StmtKind::If {
                branches,
                else_body,
            }
        } else if self.is_kw("for") {
            self.bump();
            let var = self.binder("a loop variable")?;
            self.expect(Tok::In, "`∈`")?;
            let source = self.range_or_expr()?;
            let body = self.inline_body("the `for` header")?;
            StmtKind::For { var, source, body }
        } else if self.is_kw("while") {
            self.bump();
            let cond = self.expression()?;
            let body = self.inline_body("the condition of `while`")?;
            StmtKind::While { cond, body }
        } else if self.is_kw("try") {
            self.bump();
            let body = self.inline_body("`try`")?;
            if !(self.is_kw("on") && self.is_bare_word(1, "error")) {
                return Err(self.err_expected(&["`on error` after the body of `try`"]));
            }
            self.bump();
            self.bump();
            let handler = self.inline_body("`on error`")?;
            StmtKind::Try { body, handler }
        } else if let Some(k) = self.simple_keyword()? {
            k
        } else {
            self.simple_statement(false)?
        };
        Ok(Stmt::new(kind, self.span_from(start)))
    }

    // ----------------------------------------------------------------- ranges

    fn range_or_expr(&mut self) -> PResult<Expr> {
        let start = self.start();
        let first = self.expression()?;
        if !matches!(self.peek().tok, Tok::Comma | Tok::DotDot) {
            return Ok(first);
        }
        if !fits(Pos::AddExpr, &first) {
            return Err(self.err_span(
                first.span,
                "a range bound must be an arithmetic expression (use parentheses)",
            ));
        }
        let second = if self.eat(&Tok::Comma) {
            Some(Box::new(self.add_expr()?))
        } else {
            None
        };
        self.expect(Tok::DotDot, "`..`")?;
        let last = self.add_expr()?;
        Ok(Expr::new(
            ExprKind::Range {
                first: Box::new(first),
                second,
                last: Box::new(last),
            },
            self.span_from(start),
        ))
    }

    // ----------------------------------------------------------------- expressions

    fn bin(&self, op: BinaryOp, l: Expr, r: Expr, split: bool, start: usize) -> Expr {
        Expr::new(ExprKind::binary(op, l, r, split), self.span_from(start))
    }

    fn un(&self, op: UnaryOp, e: Expr, start: usize) -> Expr {
        Expr::new(ExprKind::unary(op, e), self.span_from(start))
    }

    fn expression(&mut self) -> PResult<Expr> {
        let start = self.start();
        let mut left = self.and_expr()?;
        loop {
            let op = match self.peek().tok {
                Tok::Or => BinaryOp::Or,
                Tok::Xor => BinaryOp::Xor,
                Tok::Gap => BinaryOp::Gap,
                _ => break,
            };
            self.bump();
            let right = self.and_expr()?;
            left = self.bin(op, left, right, false, start);
        }
        Ok(left)
    }

    fn and_expr(&mut self) -> PResult<Expr> {
        let start = self.start();
        let mut left = self.not_expr()?;
        while self.eat(&Tok::And) {
            let right = self.not_expr()?;
            left = self.bin(BinaryOp::And, left, right, false, start);
        }
        Ok(left)
    }

    fn not_expr(&mut self) -> PResult<Expr> {
        let start = self.start();
        if self.eat(&Tok::Not) {
            let e = self.not_expr()?;
            return Ok(self.un(UnaryOp::Not, e, start));
        }
        self.cmp_expr()
    }

    fn cmp_expr(&mut self) -> PResult<Expr> {
        let start = self.start();
        let mut left = self.add_expr()?;
        loop {
            let op = match self.peek().tok {
                Tok::EqEq => BinaryOp::Eq,
                Tok::Ne => BinaryOp::Ne,
                Tok::Lt => BinaryOp::Lt,
                Tok::Gt => BinaryOp::Gt,
                Tok::Le => BinaryOp::Le,
                Tok::Ge => BinaryOp::Ge,
                Tok::In => BinaryOp::In,
                _ => break,
            };
            self.bump();
            let right = self.add_expr()?;
            left = self.bin(op, left, right, false, start);
        }
        Ok(left)
    }

    /// After a breakable operator: consumes an equation break, if any.
    fn equation_break(&mut self) -> PResult<bool> {
        match self.peek().tok {
            Tok::Newline(i) if i > self.stmt_indent => {
                self.bump();
                Ok(true)
            }
            Tok::Newline(_) => {
                let next = self.peek_n(1).span;
                Err(self.err_span(
                    next,
                    "the continuation of a broken line must be indented more than the line it continues",
                ))
            }
            _ => Ok(false),
        }
    }

    fn add_expr(&mut self) -> PResult<Expr> {
        let start = self.start();
        let mut left = self.polar_expr()?;
        loop {
            let op = match self.peek().tok {
                Tok::Plus => BinaryOp::Add,
                Tok::Minus => BinaryOp::Sub,
                _ => break,
            };
            self.bump();
            let split = self.equation_break()?;
            let right = self.polar_expr()?;
            left = self.bin(op, left, right, split, start);
        }
        Ok(left)
    }

    /// `r∠θ`: looser than `·` and juxtaposition, tighter than `+`, not chaining.
    fn polar_expr(&mut self) -> PResult<Expr> {
        let start = self.start();
        let left = self.mul_expr()?;
        if !self.at(&Tok::Angle) {
            return Ok(left);
        }
        self.bump();
        let right = self.mul_expr()?;
        if self.at(&Tok::Angle) {
            return Err(
                self.err_expected(&["an operator other than a second `∠` (it does not chain)"])
            );
        }
        Ok(self.bin(BinaryOp::Polar, left, right, false, start))
    }

    fn starts_operand(&self, t: &Token) -> bool {
        match &t.tok {
            Tok::Num(_)
            | Tok::Imag(..)
            | Tok::Str(_)
            | Tok::Placeholder
            | Tok::Ident(..)
            | Tok::JuliaQual(..)
            | Tok::LParen
            | Tok::LBrack
            | Tok::Sqrt
            | Tok::Vec
            | Tok::Conj
            | Tok::RealPart
            | Tok::ImagPart
            | Tok::Det
            | Tok::AbsWord
            | Tok::NormWord => true,
            Tok::Bar => self.closer != Some(Closer::Bar),
            Tok::DBar => self.closer != Some(Closer::DBar),
            t => is_big_head(t),
        }
    }

    /// Is a juxtaposed operand next? (`JUXT`, plus `2x` read as `2 x`.)
    fn juxt_ahead(&self) -> bool {
        let t = self.peek();
        if !self.starts_operand(t) {
            return false;
        }
        if t.space_before {
            return true;
        }
        let prev_is_number =
            self.pos > 0 && matches!(self.toks[self.pos - 1].tok, Tok::Num(_) | Tok::Imag(..));
        let letters = matches!(&t.tok, Tok::Ident(..))
            && self.src[t.span.range()]
                .chars()
                .next()
                .is_some_and(|c| c != '`');
        prev_is_number && letters
    }

    fn mul_expr(&mut self) -> PResult<Expr> {
        let start = self.start();
        let mut left = self.mul_operand()?;
        loop {
            let (op, breakable) = match self.peek().tok {
                Tok::Dot => (BinaryOp::Mul, true),
                Tok::InlineDiv => (BinaryOp::InlineDiv, true),
                Tok::Cross => (BinaryOp::Cross, false),
                Tok::Conv => (BinaryOp::Conv, false),
                Tok::CircConv => (BinaryOp::CircConv, false),
                _ if self.juxt_ahead() => {
                    let right = self.juxt_operand()?;
                    left = self.bin(BinaryOp::Juxt, left, right, false, start);
                    continue;
                }
                _ => break,
            };
            self.bump();
            let split = breakable && self.equation_break()?;
            let right = self.mul_operand()?;
            left = self.bin(op, left, right, split, start);
        }
        Ok(left)
    }

    fn mul_operand(&mut self) -> PResult<Expr> {
        if is_big_head(&self.peek().tok) {
            self.big_op()
        } else {
            self.neg_expr()
        }
    }

    fn juxt_operand(&mut self) -> PResult<Expr> {
        if is_big_head(&self.peek().tok) {
            self.big_op()
        } else {
            self.frac_expr()
        }
    }

    fn neg_expr(&mut self) -> PResult<Expr> {
        let start = self.start();
        if self.eat(&Tok::Minus) {
            let e = if is_big_head(&self.peek().tok) {
                self.big_op()?
            } else {
                self.neg_expr()?
            };
            return Ok(self.un(UnaryOp::Neg, e, start));
        }
        self.frac_expr()
    }

    fn frac_expr(&mut self) -> PResult<Expr> {
        let start = self.start();
        let first = self.pow_expr()?;
        if !self.at(&Tok::Slash) {
            return Ok(first);
        }
        let mut left = unbox(first);
        while self.eat(&Tok::Slash) {
            let right = unbox(self.pow_expr()?);
            left = self.bin(BinaryOp::Div, left, right, false, start);
        }
        Ok(left)
    }

    fn pow_expr(&mut self) -> PResult<Expr> {
        let start = self.start();
        let base = self.postfix()?;
        if self.eat(&Tok::Caret) {
            let exp = unbox(self.exponent()?);
            return Ok(self.bin(BinaryOp::Pow, base, exp, false, start));
        }
        Ok(base)
    }

    fn exponent(&mut self) -> PResult<Expr> {
        let start = self.start();
        if self.eat(&Tok::Minus) {
            let e = self.exponent()?;
            return Ok(self.un(UnaryOp::Neg, e, start));
        }
        self.pow_expr()
    }

    /// The lower slot of `∑` / `∏`: a plain index with optional bounds
    /// typed with `∈`, `=` or `:=`, or any other expression (a free slot).
    #[allow(clippy::type_complexity)]
    fn sum_slot(&mut self) -> PResult<(Ident, Option<Box<Expr>>, Option<Bounds>)> {
        let saved = self.save();
        if matches!(self.peek().tok, Tok::Ident(..) | Tok::Placeholder) {
            let var = self.binder("a variable name")?;
            let glyph = match self.peek().tok {
                Tok::In => Some(BoundGlyph::In),
                Tok::Equals => Some(BoundGlyph::Equals),
                Tok::ColonEq => Some(BoundGlyph::Define),
                _ => None,
            };
            match glyph {
                None if self.at(&Tok::RBrack) => return Ok((var, None, None)),
                Some(glyph) => {
                    self.bump();
                    if let Some(bounds) = self.slot_bounds(glyph) {
                        if self.at(&Tok::RBrack) {
                            return Ok((var, None, Some(bounds)));
                        }
                    }
                }
                None => {}
            }
            self.restore(saved);
        }
        let index = self.cmp_expr()?;
        let glyph = match self.peek().tok {
            Tok::Equals => Some(BoundGlyph::Equals),
            Tok::ColonEq => Some(BoundGlyph::Define),
            _ => None,
        };
        let bounds = match glyph {
            Some(glyph) => {
                self.bump();
                let lo = self.add_expr()?;
                self.expect(Tok::DotDot, "`..`")?;
                let hi = self.add_expr()?;
                Some(Bounds {
                    lo: Box::new(lo),
                    hi: Box::new(hi),
                    glyph,
                })
            }
            None => None,
        };
        Ok((Ident::new(Name::plain("")), Some(Box::new(index)), bounds))
    }

    /// `lo..hi` after the glyph of a slot; `None` (the caller backtracks) when it is not there.
    fn slot_bounds(&mut self, glyph: BoundGlyph) -> Option<Bounds> {
        let lo = self.add_expr().ok()?;
        if !self.eat(&Tok::DotDot) {
            return None;
        }
        let hi = self.add_expr().ok()?;
        Some(Bounds {
            lo: Box::new(lo),
            hi: Box::new(hi),
            glyph,
        })
    }

    fn big_op(&mut self) -> PResult<Expr> {
        let start = self.start();
        let head = self.bump();
        let glyph = &self.src[head.span.range()];
        let glyph = glyph.to_string();
        if !self.at(&Tok::LBrack) {
            return Err(self.err_expected(&[&format!("`[` after `{glyph}`")]));
        }
        self.bump();
        let kind = self.with_brackets(|p| -> PResult<ExprKind> {
            if matches!(head.tok, Tok::Sum | Tok::Prod) {
                let (var, index, bounds) = p.sum_slot()?;
                p.expect(Tok::RBrack, "`]`")?;
                let body = Box::new(Expr::synth(ExprKind::Placeholder));
                return Ok(if head.tok == Tok::Sum {
                    ExprKind::Sum {
                        var,
                        index,
                        bounds,
                        body,
                    }
                } else {
                    ExprKind::Prod {
                        var,
                        index,
                        bounds,
                        body,
                    }
                });
            }
            let var = p.binder("a variable name")?;
            let placeholder = Box::new(Expr::synth(ExprKind::Placeholder));
            // The gradient takes a list of variables.
            if head.tok == Tok::Nabla {
                let mut vars = vec![var];
                while p.eat(&Tok::Comma) {
                    vars.push(p.binder("a variable name")?);
                }
                p.expect(Tok::RBrack, "`]`")?;
                return Ok(ExprKind::Gradient {
                    vars,
                    body: placeholder,
                });
            }
            let kind = match head.tok {
                Tok::Sum | Tok::Prod | Tok::Integral => {
                    let bounds = if p.eat(&Tok::In) {
                        let lo = p.add_expr()?;
                        p.expect(Tok::DotDot, "`..`")?;
                        let hi = p.add_expr()?;
                        Some(Bounds {
                            lo: Box::new(lo),
                            hi: Box::new(hi),
                            glyph: BoundGlyph::In,
                        })
                    } else {
                        None
                    };
                    let algorithm = if p.eat(&Tok::Semi) {
                        Some(p.ident("an integration algorithm name")?)
                    } else {
                        None
                    };
                    ExprKind::Integral {
                        var,
                        bounds,
                        algorithm,
                        body: placeholder,
                    }
                }
                Tok::DerivD | Tok::Partial => {
                    let order = if p.eat(&Tok::Caret) {
                        Some(Box::new(unbox(p.exponent()?)))
                    } else {
                        None
                    };
                    if head.tok == Tok::DerivD {
                        ExprKind::Deriv {
                            var,
                            order,
                            body: placeholder,
                        }
                    } else {
                        ExprKind::Partial {
                            var,
                            order,
                            body: placeholder,
                        }
                    }
                }
                _ => {
                    p.expect(Tok::Comma, "`,`")?;
                    let target = p.add_expr()?;
                    let side = if p.eat(&Tok::Comma) {
                        match p.peek().tok {
                            Tok::Plus => LimitSide::Right,
                            Tok::Minus => LimitSide::Left,
                            _ => return Err(p.err_expected(&["`+`", "`-`"])),
                        }
                    } else {
                        LimitSide::Both
                    };
                    if side != LimitSide::Both {
                        p.bump();
                    }
                    ExprKind::Limit {
                        var,
                        target: Box::new(target),
                        side,
                        body: placeholder,
                    }
                }
            };
            p.expect(Tok::RBrack, "`]`")?;
            Ok(kind)
        })?;
        let body = Box::new(self.mul_expr()?);
        let kind = match kind {
            ExprKind::Sum {
                var, index, bounds, ..
            } => ExprKind::Sum {
                var,
                index,
                bounds,
                body,
            },
            ExprKind::Prod {
                var, index, bounds, ..
            } => ExprKind::Prod {
                var,
                index,
                bounds,
                body,
            },
            ExprKind::Integral {
                var,
                bounds,
                algorithm,
                ..
            } => ExprKind::Integral {
                var,
                bounds,
                algorithm,
                body,
            },
            ExprKind::Deriv { var, order, .. } => ExprKind::Deriv { var, order, body },
            ExprKind::Partial { var, order, .. } => ExprKind::Partial { var, order, body },
            ExprKind::Gradient { vars, .. } => ExprKind::Gradient { vars, body },
            ExprKind::Limit {
                var, target, side, ..
            } => ExprKind::Limit {
                var,
                target,
                side,
                body,
            },
            other => other,
        };
        Ok(Expr::new(kind, self.span_from(start)))
    }

    fn postfix(&mut self) -> PResult<Expr> {
        let start = self.start();
        let mut e = self.primary()?;
        loop {
            let t = self.peek();
            let adjacent = !t.space_before;
            let kind = match t.tok {
                Tok::LParen if adjacent => {
                    let args = self.call_args()?;
                    ExprKind::Call {
                        callee: Box::new(e),
                        args,
                    }
                }
                Tok::LBrack if adjacent => {
                    let indices = self.index_suffix(SubscriptRange::Allowed)?;
                    ExprKind::Index {
                        base: Box::new(e),
                        indices,
                    }
                }
                Tok::LAngle if adjacent => {
                    let index = self.angle_suffix(Tok::RAngle, "`⟩`", true)?;
                    ExprKind::Column {
                        base: Box::new(e),
                        index: Box::new(index),
                    }
                }
                Tok::LDAngle if adjacent => {
                    let index = self.angle_suffix(Tok::RDAngle, "`⟫`", true)?;
                    ExprKind::Row {
                        base: Box::new(e),
                        index: Box::new(index),
                    }
                }
                Tok::Transpose => {
                    self.bump();
                    ExprKind::Transpose { expr: Box::new(e) }
                }
                Tok::Bang => {
                    self.bump();
                    ExprKind::Factorial { expr: Box::new(e) }
                }
                // the reference application's percent is postfix.
                Tok::Percent => {
                    self.bump();
                    ExprKind::Percent { expr: Box::new(e) }
                }
                // The per mille, built like the percent.
                Tok::Permille => {
                    self.bump();
                    ExprKind::Permille { expr: Box::new(e) }
                }
                Tok::Prime => {
                    self.bump();
                    match e.kind {
                        ExprKind::PrimeDeriv { function, order } => ExprKind::PrimeDeriv {
                            function,
                            order: order + 1,
                        },
                        kind => ExprKind::PrimeDeriv {
                            function: Box::new(Expr::new(kind, e.span)),
                            order: 1,
                        },
                    }
                }
                _ => break,
            };
            e = Expr::new(kind, self.span_from(start));
        }
        Ok(e)
    }

    fn call_args(&mut self) -> PResult<Vec<Arg>> {
        self.bump(); // `(`
        self.with_brackets(|p| {
            if p.eat(&Tok::RParen) {
                return Ok(Vec::new());
            }
            let args = p.argument_list()?;
            p.expect(Tok::RParen, "`,` or `)`")?;
            Ok(args)
        })
    }

    /// One argument, then `, argument` while the commas continue: the list ends before the closing
    /// `)`, or at the end of the text (`parse_arguments`).
    fn argument_list(&mut self) -> PResult<Vec<Arg>> {
        let mut args = Vec::new();
        loop {
            args.push(self.argument()?);
            if !self.eat(&Tok::Comma) {
                return Ok(args);
            }
        }
    }

    fn argument(&mut self) -> PResult<Arg> {
        let start = self.start();
        let saved = self.save();
        // the target of an inline argument definition is a target of 7.3, so a
        // destructuring matrix is written there too (`f(a, [x, y] ← [1, 2])`), and a function head
        // (`matrix(n, n, g(i, j) ← i + j)`): an anonymous function passed as the argument.
        if let Ok(target) = self.target() {
            if self.eat(&Tok::LArrow) {
                let value = self.expression()?;
                return Ok(Arg::InlineDef {
                    target,
                    value,
                    span: self.span_from(start),
                });
            }
        }
        self.restore(saved);
        let first = self.expression()?;
        if !self.at(&Tok::DotDot) {
            return Ok(Arg::Expr { expr: first });
        }
        // a two-bound range is an argument (`vec(1..3)`); the comma separates arguments,
        // so it has no step form here.
        if !fits(Pos::AddExpr, &first) {
            return Err(self.err_span(
                first.span,
                "a range bound must be an arithmetic expression (use parentheses)",
            ));
        }
        self.bump(); // `..`
        let last = self.add_expr()?;
        Ok(Arg::Expr {
            expr: Expr::new(
                ExprKind::Range {
                    first: Box::new(first),
                    second: None,
                    last: Box::new(last),
                },
                self.span_from(start),
            ),
        })
    }

    fn primary(&mut self) -> PResult<Expr> {
        let start = self.start();
        let t = self.peek().clone();
        let kind = match t.tok {
            Tok::Num(text) => {
                self.bump();
                ExprKind::Num { text }
            }
            Tok::Imag(text, symbol) => {
                self.bump();
                ExprKind::Imag { text, symbol }
            }
            Tok::Str(value) => {
                self.bump();
                ExprKind::Str { text: value }
            }
            Tok::Placeholder => {
                self.bump();
                ExprKind::Placeholder
            }
            Tok::Ident(name, bare) => {
                if bare.as_deref() == Some("program") {
                    match self.peek_n(1).tok {
                        Tok::LBrace => return self.inline_program(),
                        Tok::Newline(_) | Tok::Eof => {
                            return Err(self.err_here(
                                "a block `program` must be the whole right side of `:=`, `≡` or `←` (use `program { … }` inside an expression)",
                            ))
                        }
                        _ => {}
                    }
                }
                self.bump();
                ExprKind::Ident { name }
            }
            Tok::JuliaQual(package, name) => {
                self.bump();
                if !(self.at(&Tok::LParen) && !self.peek().space_before) {
                    // `julia.k`: a value of a Julia block, or the function a definition
                    // registers; a package call needs `(`.
                    if package == "julia" {
                        return Ok(Expr::new(
                            ExprKind::JuliaCall {
                                package,
                                name,
                                args: Vec::new(),
                                bare: true,
                            },
                            self.span_from(start),
                        ));
                    }
                    return Err(self.err_expected(&["`(` after a qualified Julia function name"]));
                }
                let args = self.call_args()?;
                ExprKind::JuliaCall {
                    package,
                    name,
                    args,
                    bare: false,
                }
            }
            Tok::LParen => {
                self.bump();
                // A parenthesised local definition `(target ← e)` is an operand of any
                // expression: the parentheses belong to the form,
                // so the definition is the content of a `Paren` node. A bare `target ← e` stays
                // a program statement or a call argument.
                let inner = self.save();
                if let Ok(definition) = self.with_brackets(|p| {
                    let start = p.start();
                    let target = p.destructure_cell()?;
                    p.expect(Tok::LArrow, "`←`")?;
                    let value = p.expression()?;
                    p.expect(Tok::RParen, "`)`")?;
                    Ok(Expr::new(
                        ExprKind::InlineDef {
                            target,
                            value: Box::new(value),
                        },
                        p.span_from(start),
                    ))
                }) {
                    return Ok(Expr::new(
                        ExprKind::Paren {
                            expr: Box::new(definition),
                        },
                        self.span_from(start),
                    ));
                }
                self.restore(inner);
                let e = self.with_brackets(|p| {
                    let e = p.expression()?;
                    if p.at(&Tok::DotDot) || p.at(&Tok::Comma) && p.peek_n(2).tok == Tok::DotDot {
                        return Err(p.err_here("a range cannot be written inside parentheses"));
                    }
                    p.expect(Tok::RParen, "`)`")?;
                    Ok(e)
                })?;
                ExprKind::Paren { expr: Box::new(e) }
            }
            Tok::LBrack => return self.matrix(),
            Tok::Bar | Tok::DBar => {
                self.bump();
                let (closer, close_tok, what) = if t.tok == Tok::Bar {
                    (Closer::Bar, Tok::Bar, "`|`")
                } else {
                    (Closer::DBar, Tok::DBar, "`‖`")
                };
                let saved = self.closer.replace(closer);
                let e = self.expression();
                let e = e.and_then(|e| {
                    self.expect(close_tok, what)?;
                    Ok(e)
                });
                self.closer = saved;
                let e = Box::new(e?);
                if t.tok == Tok::Bar {
                    ExprKind::Abs { expr: e }
                } else {
                    ExprKind::Norm { expr: e }
                }
            }
            Tok::AbsWord
            | Tok::NormWord
            | Tok::Vec
            | Tok::Conj
            | Tok::RealPart
            | Tok::ImagPart
            | Tok::Det => {
                self.bump();
                if !self.at(&Tok::LParen) {
                    let word = self.src[t.span.range()].to_string();
                    return Err(self.err_expected(&[&format!("`(` after `{word}`")]));
                }
                self.bump();
                let e = self.with_brackets(|p| {
                    let e = p.expression()?;
                    p.expect(Tok::RParen, "`)`")?;
                    Ok(e)
                })?;
                let op = match t.tok {
                    Tok::AbsWord => UnaryOp::Abs,
                    Tok::NormWord => UnaryOp::Norm,
                    Tok::Vec => UnaryOp::Vectorize,
                    Tok::Conj => UnaryOp::Conj,
                    Tok::RealPart => UnaryOp::RealPart,
                    Tok::ImagPart => UnaryOp::ImagPart,
                    _ => UnaryOp::Det,
                };
                ExprKind::unary(op, e)
            }
            Tok::Sqrt => {
                self.bump();
                let index = if self.at(&Tok::LBrack) && !self.peek().space_before {
                    self.bump();
                    let e = self.with_brackets(|p| {
                        let e = p.expression()?;
                        p.expect(Tok::RBrack, "`]`")?;
                        Ok(e)
                    })?;
                    Some(Box::new(e))
                } else {
                    None
                };
                let radicand = Box::new(unbox(self.postfix()?));
                ExprKind::Root { index, radicand }
            }
            _ => {
                return Err(match t.tok {
                    Tok::Bang | Tok::Transpose | Tok::Prime => {
                        self.err_here("a postfix operator needs an operand before it")
                    }
                    Tok::Cdots | Tok::Vdots | Tok::Ddots => {
                        self.err_here("an ellipsis cell is only allowed as a matrix cell")
                    }
                    _ => self.err_expected(&["an expression"]),
                })
            }
        };
        Ok(Expr::new(kind, self.span_from(start)))
    }

    /// `matrix-cell = expression | ellipsis`: the three
    /// display-only ellipsis glyphs are a whole cell and never an expression.
    fn matrix_cell(&mut self) -> PResult<Expr> {
        let form = match self.peek().tok {
            Tok::Cdots => Some(EllipsisForm::Horizontal),
            Tok::Vdots => Some(EllipsisForm::Vertical),
            Tok::Ddots => Some(EllipsisForm::Diagonal),
            _ => None,
        };
        let Some(form) = form else {
            return self.expression();
        };
        let start = self.start();
        self.bump();
        Ok(Expr::new(
            ExprKind::EllipsisCell { form },
            self.span_from(start),
        ))
    }

    fn matrix(&mut self) -> PResult<Expr> {
        let start = self.start();
        self.bump(); // `[`
        let (rows, cols, cells) = self.with_brackets(|p| {
            if p.eat(&Tok::RBrack) {
                return Ok((0, 0, Vec::new()));
            }
            let mut cells = Vec::new();
            let mut rows = 0;
            let mut cols = 0;
            loop {
                let row_start = p.start();
                let mut n = 0;
                loop {
                    cells.push(p.matrix_cell()?);
                    n += 1;
                    if !p.eat(&Tok::Comma) {
                        break;
                    }
                }
                if rows == 0 {
                    cols = n;
                } else if n != cols {
                    return Err(p.err_span(
                        p.span_from(row_start),
                        format!("matrix row {} has {n} cells, expected {cols}", rows + 1),
                    ));
                }
                rows += 1;
                if !p.eat(&Tok::Semi) {
                    break;
                }
            }
            p.expect(Tok::RBrack, "`,`, `;` or `]`")?;
            Ok((rows, cols, cells))
        })?;
        Ok(Expr::new(
            ExprKind::Matrix { rows, cols, cells },
            self.span_from(start),
        ))
    }
}

fn is_big_head(t: &Tok) -> bool {
    matches!(
        t,
        Tok::Sum | Tok::Prod | Tok::Integral | Tok::DerivD | Tok::Partial | Tok::Nabla | Tok::Lim
    )
}

/// `box(X)`: one pair of parentheses around a whole box is grouping only (D5) — except the pair
/// of a parenthesised local definition, which belongs to the form and is kept as a `Paren`
///: `6/(z ← 3)` has the definition as the denominator, not a `Paren` its user typed.
fn unbox(e: Expr) -> Expr {
    match e.kind {
        ExprKind::Paren { expr } if !matches!(expr.kind, ExprKind::InlineDef { .. }) => *expr,
        _ => e,
    }
}
