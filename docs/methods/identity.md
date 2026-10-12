# Identity

**[EST]** `identity` exercises the solver plumbing by repeatedly assessing its start without moving pieces. It generates no candidate when start is absent. Source: `packages/solver/src/methods.ts`.

Its described JSON Schema exposes `iterations`, a positive integer defaulting to 1. The mandatory start assessment counts separately, so default identity itself uses two evaluations when its limits permit. Repeating assessments has no packing benefit; the parameter exercises budget, stop and progress handling.

**[EST]** The framework appends final polish by default, including after identity, and reserves one tenth of each overall budget for it. Set `finalPolish:false` to isolate identity's unchanged-pose behavior. An explicit last polish stage prevents another appended stage. Source: `packages/solver/src/framework.ts`, `test/decisions.test.ts`.

**[CALC]** Identity makes no search decisions and has no literature basis. Its final returned configuration can improve through the automatic polish stage.
