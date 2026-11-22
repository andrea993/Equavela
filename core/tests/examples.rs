//! The examples of math-syntax section 15: each parses to the sketched AST shape and
//! prints back to the same canonical text.

mod common;
use common::*;

/// A region example: exact S-expression (`…` in `expected` elides text).
fn region(src: &str, expected: &str) {
    let actual = sx(src);
    assert!(
        matches_elided(expected, &actual),
        "AST shape of {src:?}\n expected: {expected}\n   actual: {actual}"
    );
    assert_fixed_point(src);
}

/// A program-lines example (statements without a `program` header).
fn lines(src: &str, expected: &str) {
    let actual = sx_block(src);
    assert!(
        matches_elided(expected, &actual),
        "AST shape of {src:?}\n expected: {expected}\n   actual: {actual}"
    );
    assert_eq!(canon_block(src), src);
}

#[test]
fn e01_literal_subscript_with_period() {
    region(
        "η_p.max := (n_1·d_2 - n_2·d_1)/(a_1·d_2 - a_2·d_1) =",
        "(:= η_p.max (/ (- (· n_1 d_2) (· n_2 d_1)) (- (· a_1 d_2) (· a_2 d_1))) (=))",
    );
    let s = equavela_core::parse_statement("η_p.max := 1").unwrap();
    let equavela_core::ast::StatementKind::Define { target, .. } = s.kind else {
        panic!()
    };
    assert_eq!(
        target.kind,
        equavela_core::ast::TargetKind::Ident {
            name: equavela_core::ast::Name::sub("η", "p.max")
        }
    );
}

#[test]
fn e02_range_with_step_and_units() {
    region(
        "h_t := 0·m, 1000·m..7000·m",
        "(:= h_t (range (· 0 m) (· 1000 m) (· 7000 m)))",
    );
}

#[test]
fn e03_unit_override() {
    region("RC_max(h_t) = … m/s", "(= (call RC_max h_t) (/ m s))");
}

#[test]
fn e04_evaluation() {
    region("W =", "(= W)");
}

#[test]
fn e05_square_and_nth_root() {
    region(
        "V_mp(h) := √((2·W)/(ρ(h)·S))·√[4](k/(3·C_D0))",
        "(:= (fn V_mp h) (· (√ (/ (· 2 W) (· (call ρ h) S))) (√ 4 (/ k (· 3 C_D0)))))",
    );
}

#[test]
fn e06_imaginary_literal_and_juxtaposition() {
    region(
        "p_1c := ln(|p_1|) + 1j π",
        "(:= p_1c (+ (call ln (abs p_1)) (juxt 1j π)))",
    );
}

#[test]
fn e07_complex_result() {
    region("ln(p_2) =", "(= (call ln p_2))");
    let r = equavela_core::parse_expression("-0.481 + 3.142i").unwrap();
    assert_eq!(sx_expr(&r), "(+ (neg 0.481) 3.142i)");
}

#[test]
fn e08_recursive_function_if_else() {
    region(
        "fibo(n) := program\n  if n ≤ 2\n    1\n  else\n    fibo(n - 1) + fibo(n - 2)",
        "(:= (fn fibo n) (program (if ((≤ n 2) 1) (else (+ (call fibo (- n 1)) (call fibo (- n 2)))))))",
    );
}

#[test]
fn e09_definition_by_symbolic_result() {
    region(
        "S(n, N_z) := (2·N_z - (k - 1))/2·k == n →[solve, k]",
        "(:= (fn S n N_z) (== (· (/ (- (· 2 N_z) (paren (- k 1))) 2) k) n) (→ (solve k)))",
    );
    let r = equavela_core::parse_expression(
        "[(-√(-8·n + 4·N_z^2 + 4·N_z + 1) + 2·N_z + 1)/2; (√(-8·n + 4·N_z^2 + 4·N_z + 1) + 2·N_z + 1)/2]",
    )
    .unwrap();
    assert_eq!(
        equavela_core::print_expression(&r),
        "[(-√(-8·n + 4·N_z^2 + 4·N_z + 1) + 2·N_z + 1)/2; (√(-8·n + 4·N_z^2 + 4·N_z + 1) + 2·N_z + 1)/2]"
    );
}

#[test]
fn e10_symbolic_keyword() {
    region(
        "1/(1 - z^-1 - z^-2) →[invztrans]",
        "(→ (/ 1 (- (- 1 (^ z (neg 1))) (^ z (neg 2)))) (invztrans))",
    );
}

#[test]
fn e11_implicit_elementwise_power() {
    region("σ_ζ := [0.2, 0.3]ᵀ", "(:= σ_ζ (ᵀ (matrix 1×2 0.2 0.3)))");
    region("Q := diag(σ_ζ^2)", "(:= Q (call diag (^ σ_ζ 2)))");
    let r = equavela_core::parse_expression("[0.04, 0; 0, 0.09]").unwrap();
    assert_eq!(sx_expr(&r), "(matrix 2×2 0.04 0 0 0.09)");
}

#[test]
fn e12_builtin_if_and_inverses() {
    region(
        "ψ(X) := if(rows(X) > cols(X), (Xᵀ·X)^-1·Xᵀ, Xᵀ·(X·Xᵀ)^-1)",
        "(:= (fn ψ X) (call if (> (call rows X) (call cols X)) (· (^ (paren (· (ᵀ X) X)) (neg 1)) (ᵀ X)) (· (ᵀ X) (^ (paren (· X (ᵀ X))) (neg 1)))))",
    );
}

#[test]
fn e13_product_saved_as_scalar() {
    region(
        "(A·X_A - b)ᵀ·(A·X_A - b) =",
        "(= (· (ᵀ (paren (- (· A X_A) b))) (paren (- (· A X_A) b))))",
    );
}

#[test]
fn e14_scalar_stacked_under_vector() {
    region(
        "M := augment(stack(Q, C), stack(-Cᵀ, (C·Cᵀ)·0))",
        "(:= M (call augment (call stack Q C) (call stack (neg (ᵀ C)) (· (paren (· C (ᵀ C))) 0))))",
    );
}

#[test]
fn e15_nested_one_by_one_blocks() {
    region(
        "G_cl := [[-1/τ - G_o/τ·K], [G_o/τ]; [1], [0]]",
        "(:= G_cl (matrix 2×2 (matrix 1×1 (- (neg (/ 1 τ)) (· (/ G_o τ) K))) (matrix 1×1 (/ G_o τ)) (matrix 1×1 1) (matrix 1×1 0)))",
    );
}

#[test]
fn e16_destructuring_a_block_model() {
    region(
        "G_MISO := [[-1/τ], [B1, B2, B3]; [1], [0, 0, 0]]",
        "(:= G_MISO (matrix 2×2 (matrix 1×1 (neg (/ 1 τ))) (matrix 1×3 B1 B2 B3) (matrix 1×1 1) (matrix 1×3 0 0 0)))",
    );
    region(
        "[A_MISO, B_MISO; C_MISO, D_MISO] := G_MISO",
        "(:= (destructure 2×2 A_MISO B_MISO C_MISO D_MISO) G_MISO)",
    );
}

#[test]
fn e17_matrix_power_of_diagonal() {
    region(
        "Q_U.MISO := n_u·diag(G_asiᵀ)^2",
        "(:= Q_U.MISO (· n_u (^ (call diag (ᵀ G_asi)) 2)))",
    );
}

#[test]
fn e18_scalar_divided_by_vector() {
    region(
        "τ_ini := -1/eigenvals(A) =",
        "(:= τ_ini (neg (/ 1 (call eigenvals A))) (=))",
    );
}

#[test]
fn e19_sum_with_factorials() {
    region(
        "L(n, x) := ∑[m ∈ 0..floor(n/2)] (-1)^m·(2·n - 2·m)!/(2^n·m!·(n - m)!·(n - 2·m)!)·x^(n - 2·m)",
        "(:= (fn L n x) (∑ m 0 (call floor (/ n 2)) (· (· (^ (paren (neg 1)) m) (/ (! (paren (- (· 2 n) (· 2 m)))) (· (· (· (^ 2 n) (! m)) (! (paren (- n m)))) (! (paren (- n (· 2 m))))))) (^ x (- n (· 2 m))))))",
    );
}

#[test]
fn e20_growth_from_undefined_name() {
    region("ord := 1", "(:= ord 1)");
    region("t[1] := [0]", "(:= (index t 1) (matrix 1×1 0))");
}

#[test]
fn e21_program_with_return_and_nested_sums() {
    region(
        "GaussIntN(f, a, b, N, ord) := program\n  H ← (b - a)/N\n  w ← α(ord, t[ord])\n  if ord == 1\n    return H·∑[k ∈ 0..N - 1] f(a + (k + 1/2)·H)\n  I ← H/2·∑[k ∈ 0..N - 1] ∑[i ∈ 0..ord - 1] w[i]·f(a + (k + (1 + (t[ord])[i])/2)·H)",
        "(:= (fn GaussIntN f a b N ord) (program (← H (/ (- b a) N)) (← w (call α ord (index t ord))) (if ((== ord 1) (return (· H (∑ k 0 (- N 1) (call f (+ a (· (paren (+ k (/ 1 2))) H)))))))) (← I (· (/ H 2) (∑ k 0 (- N 1) (∑ i 0 (- ord 1) (· (index w i) (call f …))))))))",
    );
}

#[test]
fn e22_integral() {
    region(
        "I_mcd := ∫[x ∈ a..b] f(x)",
        "(:= I_mcd (∫ x a b (call f x)))",
    );
}

#[test]
fn e23_growth_in_nested_blocks() {
    region(
        "z := program\n  if a < 3\n    for i ∈ 0..10\n      x[i] ← 3 + i\n  x",
        "(:= z (program (if ((< a 3) (for i (range 0 10) (← (index x i) (+ 3 i))))) x))",
    );
}

#[test]
fn e24_two_dimensional_growth() {
    region(
        "Mat(N) := program\n  for i ∈ 0..N - 1\n    for j ∈ 0..N - 1 - i\n      y[i, j] ← [j, i + j + 1]\n  y",
        "(:= (fn Mat N) (program (for i (range 0 (- N 1)) (for j (range 0 (- (- N 1) i)) (← (index y i j) (matrix 1×2 j (+ (+ i j) 1))))) y))",
    );
}

#[test]
fn e25_zero_matrix_idiom() {
    region(
        "Zr(r, c) := program\n  Z ← 0\n  Z[r - 1, c - 1] ← 0\n  Z",
        "(:= (fn Zr r c) (program (← Z 0) (← (index Z (- r 1) (- c 1)) 0) Z))",
    );
}

#[test]
fn e26_try_on_error() {
    region(
        "Inside(a, A) := program\n  try\n    match(a, A)\n  on error\n    return 0\n  1",
        "(:= (fn Inside a A) (program (try ((call match a A)) ((return 0))) 1))",
    );
}

#[test]
fn e27_inline_argument_definition() {
    region(
        "Inside(\"a\", A ← [1, \"a\", 3]) =",
        "(= (call Inside \"a\" (← A (matrix 1×3 1 \"a\" 3))))",
    );
}

#[test]
fn e29_descending_range_nested_indexed_assignment() {
    region(
        "SetS(S, V, x) := program\n  Ndim ← rows(V)\n  \"Take S apart\"\n  s[0] ← S\n  for i ∈ 1..Ndim\n    s[i] ← (s[i - 1])[V[i - 1]]\n  \"Replace the element\"\n  s[i] ← x\n  \"Reassemble S\"\n  for i ∈ Ndim..1\n    (s[i - 1])[V[i - 1]] ← s[i]\n  s[0]",
        "(:= (fn SetS S V x) (program … (← (index (paren (index s (- i 1))) (index V (- i 1))) (index s i))…",
    );
}

#[test]
fn e30_conditional_with_nested_element_targets() {
    region(
        "Substitute(A, V, Idx_el) := program\n  V ← if(IsScalar(V), V·One(rows(Idx_el), 1), V)\n  B ← A\n  if cols(A) > 1\n    for i ∈ 0..rows(Idx_el) - 1\n      B[(Idx_el[i])[0], (Idx_el[i])[1]] ← V[i]\n  else\n    for i ∈ 0..rows(Idx_el) - 1\n      B[Idx_el[i]] ← V[i]\n  B",
        "(:= (fn Substitute A V Idx_el) (program (← V (call if (call IsScalar V) (· V (call One (call rows Idx_el) 1)) V)) (← B A) (if ((> (call cols A) 1) (for i … (← (index B (index (paren (index Idx_el i)) 0) (index (paren (index Idx_el i)) 1)) (index V i)))) (else (for i … (← (index B (index Idx_el i)) (index V i))))) B))",
    );
}

#[test]
fn e31_while_and_if_else() {
    region(
        "BisectTableSearch(Xtab, x) := program\n  n_up ← rows(Xtab) - 1\n  n_low ← 0\n  if x ≤ Xtab[n_low]\n    n_up ← n_low + 1\n  if x ≥ Xtab[n_up]\n    n_low ← n_up - 1\n  while (n_up - n_low) > 1.1\n    k ← floor((n_up + n_low)/2)\n    if Xtab[k] > x\n      n_up ← k\n    else\n      n_low ← k\n  [n_low, n_up]ᵀ",
        "…(while (> (paren (- n_up n_low)) 1.1) …) (ᵀ (matrix 1×2 n_low n_up))))",
    );
}

#[test]
fn e32_destructuring_function_result() {
    region(
        "Linterp1DBisect(Xtab, Ytab, x) := program\n  [n_low, n_up] ← BisectTableSearch(Xtab, x)ᵀ\n  a ← (x - Xtab[n_low])/(Xtab[n_up] - Xtab[n_low])\n  y ← a·Ytab[n_up] + (1 - a)·Ytab[n_low]\n  Sat(y, min(Ytab), max(Ytab))",
        "(:= (fn Linterp1DBisect Xtab Ytab x) (program (← (destructure 1×2 n_low n_up) (ᵀ (call BisectTableSearch Xtab x))) …))",
    );
}

#[test]
fn e33_program_rhs_of_destructuring_column_targets_det() {
    region(
        "[P_asi, X_pred, ρ] := program\n  \"Start from a different initial state to assess convergence\"\n  X_pred⟨0⟩ ← X⟨0⟩·0\n  P ← Q\n  ρ ← 0\n  for k ∈ 1..N_samp - 1\n    [P, X_pred⟨k⟩] ← KF_step(A, B, C, D, V, Q, R, U[k], Y_m[k], X_pred⟨k - 1⟩, P)\n    ρ[k] ← \\det(P)\n  [P, X_pred, ρ]",
        "(:= (destructure 1×3 P_asi X_pred ρ) (program \"…\" (← (col X_pred 0) (· (col X 0) 0)) … (for k (range 1 (- N_samp 1)) (← (destructure 1×2 P (col X_pred k)) (call KF_step …)) (← (index ρ k) (det P))) (matrix 1×3 P X_pred ρ)))",
    );
}

#[test]
fn e34_newton_iteration() {
    region(
        "RapsonMV(f, X_ini, δX_ini, tol, MaxSteps) := program\n  \"Points for the initial secant\"\n  X_p ← X_ini\n  X ← X_ini + δX_ini\n  F ← f(X_p)\n  k ← 0\n  while (|F|) > tol ∧ k < MaxSteps\n    \"Secant approximation of the Jacobian\"\n    J ← Secant_J(f, X_p, X)\n    X_p ← X\n    \"Newton update step\"\n    F ← f(X)\n    δX ← -J^-1·F\n    X ← X + δX\n    k ← k + 1\n  [X, k, δX, F]",
        "…(while (∧ (> (paren (abs F)) tol) (< k MaxSteps)) … (← δX (· (neg (^ J (neg 1))) F)) …",
    );
}

#[test]
fn e35_indexed_targets_in_destructuring() {
    region(
        "Hm_Y(Y) := program\n  [X[0], X[1], X[2], λ] ← Yᵀ\n  stack(H_X(X, λ), H_λ(X))",
        "(:= (fn Hm_Y Y) (program (← (destructure 1×4 (index X 0) (index X 1) (index X 2) λ) (ᵀ Y)) (call stack (call H_X X λ) (call H_λ X))))",
    );
    region(
        "[Y_opt, k, δY, F] := NewtonMV1(Hm_Y, Y_o, tol, MaxSteps)",
        "(:= (destructure 1×4 Y_opt k δY F) (call NewtonMV1 Hm_Y Y_o tol MaxSteps))",
    );
    region("[Y_opt, k, δY, F] =", "(= (matrix 1×4 Y_opt k δY F))");
}

#[test]
fn e36_guarded_sums() {
    region(
        "Cholesky(A) := program\n  L ← A·0\n  N ← rows(A)\n  for i ∈ 0..N - 1\n    L[i, i] ← √(A[i, i] - if(i > 0, ∑[k ∈ 0..i - 1] L[i, k]^2, 0))\n    if i < N - 1\n      for j ∈ i + 1..N - 1\n        L[j, i] ← 1/L[i, i]·(A[i, j] - if(i > 0, ∑[k ∈ 0..i - 1] L[i, k]·L[j, k], 0))\n  L",
        "…(← (index L j i) (· (/ 1 (index L i i)) (paren (- (index A i j) (call if (> i 0) (∑ k 0 (- i 1) (· (index L i k) (index L j k))) 0)))))…",
    );
}

#[test]
fn e37_integral_to_infinity() {
    region(
        "J == 1/2·∫[t ∈ 0..∞] ((Xᵀ·Q_X·X) + 2·Xᵀ·Q_XU·U + Uᵀ·Q_U·U)",
        "(== J (· (/ 1 2) (∫ t 0 ∞ (paren (+ (+ (paren (· (· (ᵀ X) Q_X) X)) (· (· (· 2 (ᵀ X)) Q_XU) U)) (· (· (ᵀ U) Q_U) U))))))",
    );
}

#[test]
fn e38_derivatives() {
    region("e == ⅆ[t] y - ⅆ[t] x_m", "(== e (- (ⅆ t y) (ⅆ t x_m)))");
}

#[test]
fn e39_derivative_of_order_j() {
    lines(
        "R[i, j] ← 1/j!·ⅆ[s^j] ∑[m ∈ 0..rows(b) - 1] b[m]·s^m",
        "(← (index R i j) (· (/ 1 (! j)) (ⅆ s j (∑ m 0 (- (call rows b) 1) (· (index b m) (^ s m))))))",
    );
}

#[test]
fn e40_symbol_named_function() {
    region(
        "`⊗`(A, B) := kronecker(A, B)",
        "(:= (fn `⊗` A B) (call kronecker A B))",
    );
    region(
        "`⊗`(A, (B + C)) == `⊗`(A, B) + `⊗`(A, C)",
        "(== (call `⊗` A (paren (+ B C))) (+ (call `⊗` A B) (call `⊗` A C)))",
    );
}

#[test]
fn e41_limit_of_integral() {
    region(
        "J_Q == \\lim[T, ∞] ∫[t ∈ 0..T] (xᵀ·Qxx·x + uᵀ·Quu·u)",
        "(== J_Q (lim T ∞ (∫ t 0 T (paren (+ …)))))",
    );
}

#[test]
fn e42_cross_product() {
    region("Q_X == n × n", "(== Q_X (× n n))");
}

#[test]
fn e43_nested_complex_model() {
    region(
        "zpk := [[1.414i; -1.414i]; [-0.175 + 0.181i; -0.175 - 0.181i]; 0.032]",
        "(:= zpk (matrix 3×1 (matrix 2×1 1.414i (neg 1.414i)) (matrix 2×1 (+ (neg 0.175) 0.181i) (- (neg 0.175) 0.181i)) 0.032))",
    );
}

#[test]
fn e44_conjugate_in_block_matrix() {
    region(
        "[[λ, 0; 0, \\conj(λ)], [1; 1]; [R, \\conj(R)], 0]",
        "(matrix 2×2 (matrix 2×2 λ 0 0 (conj λ)) (matrix 2×1 1 1) (matrix 1×2 R (conj R)) 0)",
    );
}

#[test]
fn e45_function_body_bare_if_else() {
    region(
        "RotXYZ2Ang(R, quad_θ) := program\n  if quad_θ == 1\n    [atan2(R[2, 2], R[2, 1]); atan2(√(R[2, 1]^2 + R[2, 2]^2), -R[2, 0]); atan2(R[0, 0], R[1, 0])]\n  else\n    [atan2(-R[2, 2], -R[2, 1]); atan2(-√(R[2, 1]^2 + R[2, 2]^2), -R[2, 0]); atan2(-R[0, 0], -R[1, 0])]",
        "(:= (fn RotXYZ2Ang R quad_θ) (program (if ((== quad_θ 1) (matrix 3×1 …)) (else (matrix 3×1 (call atan2 (neg (index R 2 2)) (neg (index R 2 1))) (call atan2 (neg (√ (+ (^ (index R 2 1) 2) (^ (index R 2 2) 2)))) (neg (index R 2 0))) (call atan2 (neg (index R 0 0)) (neg (index R 1 0))))))))",
    );
}

#[test]
fn e46_names_that_need_quoting() {
    use equavela_core::ast::{Name, Segment, StatementKind, TargetKind};
    region(
        "`indici_colonne_ingresso` := [0; 1]",
        "(:= `indici_colonne_ingresso` (matrix 2×1 0 1))",
    );
    region("`UKF_EST_λ`_step := 1", "(:= `UKF_EST_λ`_step 1)");
    region("μ_ψ_k := 0", "(:= μ_ψ_k 0)");
    let target_name = |src: &str| match equavela_core::parse_statement(src).unwrap().kind {
        StatementKind::Define { target, .. } => match target.kind {
            TargetKind::Ident { name } => name,
            _ => panic!(),
        },
        _ => panic!(),
    };
    assert_eq!(
        target_name("`indici_colonne_ingresso` := [0; 1]"),
        Name::plain("indici_colonne_ingresso")
    );
    assert_eq!(
        target_name("`UKF_EST_λ`_step := 1"),
        Name::sub("UKF_EST_λ", "step")
    );
    assert_eq!(target_name("μ_ψ_k := 0"), Name::sub("μ", "ψ_k"));
    let h2so4 = target_name("H_{2}SO_{4} := 1");
    assert_eq!(
        h2so4.segments,
        vec![
            Segment {
                text: "H".into(),
                subscript: false
            },
            Segment {
                text: "2".into(),
                subscript: true
            },
            Segment {
                text: "SO".into(),
                subscript: false
            },
            Segment {
                text: "4".into(),
                subscript: true
            },
        ]
    );
}

#[test]
fn e47_worksheet_fragment() {
    region("L := 3.5 m", "(:= L (juxt 3.5 m))");
    region("q := 12 kN/m", "(:= q (juxt 12 (/ kN m)))");
    region("M_max := q·L^2/8", "(:= M_max (· q (/ (^ L 2) 8)))");
    region("M_max =", "(= M_max)");
    let r = equavela_core::parse_expression("18.375 kN·m").unwrap();
    assert_eq!(sx_expr(&r), "(· (juxt 18.375 kN) m)");
    let r = equavela_core::parse_expression("1.09·10^4 N").unwrap();
    assert_eq!(sx_expr(&r), "(juxt (· 1.09 (^ 10 4)) N)");
}

#[test]
fn adr_0015_program_example() {
    region(
        "S(n) := program\n  s ← 0\n  for i ∈ 1..n\n    s ← s + i\n  s",
        "(:= (fn S n) (program (← s 0) (for i (range 1 n) (← s (+ s i))) s))",
    );
}

#[test]
fn section_8_3_inline_programs() {
    region(
        "f(n) := program { s ← 0; for i ∈ 1..n { s ← s + i }; s } =",
        "(:= (fn f n) (program (← s 0) (for i (range 1 n) (← s (+ s i))) s) (=))",
    );
    region(
        "g := h(program { if c { a } else if d { b } else { c } })",
        "(:= g (call h (program (if (c a) (elseif d b) (else c)))))",
    );
    region(
        "g := h(program { try { match(a, A) } on error { return 0 } })",
        "(:= g (call h (program (try ((call match a A)) ((return 0))))))",
    );
}

#[test]
fn section_10_equation_break() {
    region(
        "I_ref := -4/3·cos(b)^3 + cos(b) + b·ln(b) - b +\n    4/3·cos(a)^3 - cos(a) - a·ln(a) + a",
        "(:= I_ref (+ (- (- (+↵ (- (+ (+ (· (neg (/ 4 3)) (^ (call cos b) 3)) (call cos b)) (· b (call ln b))) b) (· (/ 4 3) (^ (call cos a) 3))) (call cos a)) (· a (call ln a))) a))",
    );
}

#[test]
fn julia_qualified_call_and_label() {
    region(
        "K := ControlSystems::lqr(A, B, Q, R)",
        "(:= K (julia ControlSystems::lqr A B Q R))",
    );
    region("y := filt@julia(b, a, x)", "(:= y (call filt@julia b a x))");
    region(
        "z := LinearAlgebra.BLAS::nrm2!(x)ᵀ",
        "(:= z (ᵀ (julia LinearAlgebra.BLAS::nrm2! x)))",
    );
}

/// a Julia block name is written `julia.f`; the older `julia::f` is still read.
#[test]
fn julia_block_names_take_the_dot_qualifier() {
    region("y := julia.f(x, 2)", "(:= y (julia julia::f x 2))");
    assert_eq!(common::canon("y := julia::f(x, 2)"), "y := julia.f(x, 2)");
    region("k_1 := julia.k_x_max", "(:= k_1 julia::k_x_max)");
    region("F(X, y) := julia.step!", "(:= (fn F X y) julia::step!)");
    // Any other dotted word stays a worksheet name.
    region("a := h_in.pipe", "(:= a h_in.pipe)");
}

/// an underscore typed into a name is part of the name, not a subscript; the text quotes it.
#[test]
fn an_underscore_inside_a_name_round_trips() {
    use equavela_core::ast::{Name, Segment};
    let name = Name {
        segments: vec![Segment {
            text: "a_b".into(),
            subscript: false,
        }],
        label: None,
    };
    let printed = equavela_core::syntax::print_name(&name);
    let statement = format!("{printed} := 1");
    assert_eq!(canon(&statement), statement, "{printed}");
    assert_ne!(
        printed, "a_b",
        "a plain a_b would read as a with subscript b"
    );
}
