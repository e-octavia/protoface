# Test fixtures — third-party content

The eight `.json` files in `anims/` are copied **unmodified** from
[NCPlyn/ProtogenHelmet-ESP32](https://github.com/NCPlyn/ProtogenHelmet-ESP32),
at `ProtoESP-Controller/data/anims/`.

They are © NCPlyn and licensed **GPL-3.0**, not under Protoface's MIT licence.

They're here because they're the only authoritative examples of the animation
format. `test.mjs` imports each one, re-exports it, and asserts every panel of
every frame comes back bit-identical — which is what makes the compatibility
claim in the README an assertion rather than a hope. Self-made fixtures would
prove that Protoface agrees with itself, which is not the same thing.

If you'd rather not have GPL content in your checkout, delete this folder and
point the tests at your own copy of the firmware:

```
node test.mjs /path/to/ProtoESP-Controller/data/anims
```
