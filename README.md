# Equavela

Equavela is an open-source scientific worksheet for Windows and Linux.

Website: [equavela.org](https://equavela.org)

It brings live mathematics, explanatory text, physical units, matrices, and visualizations together on clean, paginated worksheets. Results recalculate automatically as you edit, and print/PDF output matches the screen exactly.

## Features

- **Live Calculations & Symbolic Math:** Write formulas in standard mathematical notation. Numerical evaluation is powered by Julia, and symbolic manipulation is backed by SymPy.
- **Units & Dimensional Analysis:** Seamless integration of physical units with automatic conversion and dimensional consistency checks.
- **Vectors, Matrices & Algorithms:** Full linear algebra support, user-defined functions, and structured algorithmic constructs (loops, conditionals).
- **Interactive Visualizations:** 2D Cartesian plots (Plotly.js) embedded directly in the worksheet alongside your calculations.
- **Readable Open Format:** Worksheets are stored as human-readable YAML documents (`.eqv`) with mathematical expressions in linear notation.
- **Legacy Interoperability:** Import capability for legacy scientific worksheet formats.
- **WYSIWYG Layout:** Precision paginated layout ensuring what you see on screen is identical to the printed or exported PDF document.

## Architecture

- **Core Engine (`equavela-core`):** Written in Rust. Handles document data structures, AST parsing, dependency graphs, reactive recalculation scheduling, and code generation.
- **User Interface (`app`):** Desktop shell built with Tauri 2, React, and TypeScript. Provides the math editor, ribbon navigation, and plotting canvas.
- **Numerical Kernel (`kernel/EqRuntime`):** Native Julia runtime delivering high-performance numerical operations and worksheet semantics.
- **Symbolics Kernel:** SymPy integrated via PythonCall for algebraic simplification, calculus, and exact equation solving.

## Getting Started

### Prerequisites

- **Rust:** Stable toolchain (`rustup`)
- **Node.js:** LTS with `pnpm`
- **Julia:** Version 1.13 or later (via [juliaup](https://github.com/JuliaLang/juliaup))

### Building from Source

```bash
# Clone the repository with the user manual (submodule docs/manual)
git clone --recurse-submodules https://github.com/andrea993/Equavela.git
cd Equavela

# Install frontend dependencies
pnpm --dir app install

# Run the desktop app in development mode
pnpm --dir app tauri dev
```

### Running Tests

```bash
# Run Rust workspace tests
cargo test --workspace

# Run frontend tests
pnpm --dir app test

# Run Julia runtime tests
julia --project=kernel/EqRuntime -e "using Pkg; Pkg.test()"
```

## License

Equavela is licensed under the [Mozilla Public License 2.0 (MPL-2.0)](LICENSE).
