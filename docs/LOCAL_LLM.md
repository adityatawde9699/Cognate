# Built-in local model

Cognate can run a language model inside the app, so AI estimate, Brief me and
quick-add work offline without Ollama or any other server. Choose
**Settings → AI → Provider → Built-in (offline, no server)**, pick a model and
press Download. The model is a GGUF file stored in the app data directory
(`models/`). Nothing is sent anywhere; the only network request is the model
download itself.

## Models

Defined in `src-tauri/src/local_llm.rs` (`CATALOG`). Each entry pins a Hugging
Face commit and a SHA-256. A download is rejected and deleted if its size or
checksum differs.

| Id | Size | Notes |
|---|---|---|
| `qwen2.5-0.5b` | 491 MB | Fastest, lowest quality. Durations are snapped to 15 minutes. |
| `qwen2.5-1.5b` | 1.1 GB | Default. |
| `llama3.2-3b` | 2.0 GB | Best quality; wants a GPU or a fast CPU. |

## GPU or CPU

The model runs on the GPU when the build includes a GPU backend and a device is
present, and on the CPU otherwise. Settings shows which one it found.

- **Default build** (`embedded-llm`): CPU everywhere, plus Metal on macOS.
- **GPU build** (`embedded-llm-gpu`, Linux/Windows): adds CUDA as a module that
  is loaded at run time. If there is no NVIDIA GPU or driver the module does not
  load and the CPU backend is used, so the same installer works on every machine.
- If loading on the GPU fails (for example not enough VRAM) or generation fails
  mid-way, the model reloads on the CPU and the request is retried once.

## Building

Needs `cmake`, a C++ compiler and libclang (bindgen). On Linux without the
`clang` package, bindgen may not find compiler headers; set
`BINDGEN_EXTRA_CLANG_ARGS=-I/usr/lib/gcc/<triple>/<version>/include`.

```sh
cargo build --release                                  # CPU (Metal on macOS)
cargo build --release --features embedded-llm-gpu      # + CUDA module
cargo build --release --no-default-features           # no embedded engine
```

The GPU build needs the CUDA toolkit. CUDA 12.x supports GCC up to 14: set
`CUDAHOSTCXX=/usr/bin/g++-14` when the default compiler is newer. Set
`CMAKE_CUDA_ARCHITECTURES` (for example `120` for RTX 50-series) to compile only
the architectures you need.

### Shipping the GPU backend modules

`embedded-llm-gpu` links llama.cpp as shared libraries and loads the compute
backends as modules. From the crate's build output (`llama-cpp-sys-2-*/out`)
ship:

- `lib/` (`libllama`, `libggml`, `libggml-base`, ...): next to the executable, on
  the library search path. **Required**; without them the app will not start.
- `backends/` (`libggml-cuda`, `libggml-cpu-*`): in a `llm-backends/` directory
  next to the executable, or point `COGNATE_LLM_BACKENDS` at it. The `libggml-cpu-*`
  variants are the CPU backend in this build, so they are also required; the CUDA
  module is the only optional one.

None of this is wired into the Tauri bundle yet. Until it is, ship the default
build (`embedded-llm`), which is self-contained.

## Testing

```sh
COGNATE_TEST_GGUF=/path/to/qwen2.5-0.5b-instruct-q4_k_m.gguf \
  cargo test --lib real_model -- --ignored --nocapture
# add COGNATE_EXPECT_GPU=1 to fail unless the model landed on the GPU
```
