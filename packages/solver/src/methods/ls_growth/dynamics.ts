import {
  boundingRadius,
  containerInradius,
  DISK_RADIUS,
  findOverlaps,
  pieceSeparation,
  visitContainerProtrusions,
  type Container,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";
import {
  collideDiscs,
  discCircleWallTime,
  discDiscTime,
  discEdgeTime,
  EventQueue,
  horizonPairs,
  type Event,
  type Velocity,
} from "./events";

export interface Advance {
  dt: number;
  collision: boolean;
  repaired: boolean;
  failed: boolean;
}

export class GrowthDynamics {
  readonly pieces: Pose[];
  readonly velocities: Velocity[];
  readonly container: Container;
  scale: number;
  repairs = 0;
  collisions = 0;
  operations = 0;
  /**
   * Relative cost of scanning every piece once (one feasibility probe): the pair and wall
   * tests grow with the vertex counts. Callers count it to place cooperative checkpoints
   * by work done, never by elapsed time.
   */
  readonly work: number;
  private readonly initialEnergy: number;

  constructor(
    readonly template: PackingConfig,
    container: Container,
    initialScale: number,
    readonly growth: number,
    speed: number,
    angularSpeed: number,
    random: () => number,
  ) {
    this.container = { ...container, cx: 0, cy: 0 };
    this.pieces = template.pieces.map((p) => ({ ...p, x: p.x - container.cx, y: p.y - container.cy }));
    this.scale = initialScale;
    this.work = this.pieces.length * (1 + (template.N + template.M) / 16);
    this.velocities = this.pieces.map(() => {
      const angle = 2 * Math.PI * random();
      return {
        x: speed * Math.cos(angle),
        y: speed * Math.sin(angle),
        omega: template.N === 0 ? 0 : angularSpeed * (2 * random() - 1),
      };
    });
    this.initialEnergy = this.energy();
  }

  energy(): number {
    return this.velocities.reduce((sum, v) => sum + v.x * v.x + v.y * v.y, 0);
  }

  thermostat(factor: number): boolean {
    const energy = this.energy();
    if (energy <= factor * this.initialEnergy) return false;
    const multiplier = Math.sqrt(this.initialEnergy / energy);
    for (const v of this.velocities) {
      v.x *= multiplier;
      v.y *= multiplier;
    }
    return true;
  }

  config(scale = this.scale): PackingConfig {
    return {
      ...this.template,
      container_phi: this.container.phi,
      pieces: this.pieces.map((p) => ({ ...p, x: p.x / scale, y: p.y / scale })),
    };
  }

  unitContainer(scale = this.scale): Container {
    return { ...this.container, size: this.container.size / scale };
  }

  feasible(scale = this.scale, stopped: () => boolean = () => false): boolean {
    if (!(scale > 0) || !Number.isFinite(scale)) return false;
    if (findOverlaps(this.template.N, this.pieces, 0, scale).length) return false;
    const container = this.unitContainer(scale);
    for (const p of this.pieces) {
      if (stopped()) return false;
      let valid = true;
      visitContainerProtrusions(
        this.template.N,
        { ...p, x: p.x / scale, y: p.y / scale },
        container,
        (depth) => {
          if (!Number.isFinite(depth) || depth > 0) valid = false;
        },
        true,
      );
      if (!valid) return false;
    }
    return true;
  }

  /** Only roundoff-size violations are repaired; substantial missed events end this run. */
  repair(stopped: () => boolean): boolean {
    if (this.feasible(this.scale, stopped)) return true;
    const original = this.scale;
    for (const fraction of [2e-14, 2e-13, 2e-12, 2e-11, 2e-10, 2e-9]) {
      if (stopped()) return false;
      this.scale = original * (1 - fraction);
      if (this.feasible(this.scale, stopped)) {
        this.repairs++;
        return true;
      }
    }
    this.scale = original;
    return false;
  }

  private move(dt: number): void {
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      const v = this.velocities[i];
      p.x += v.x * dt;
      p.y += v.y * dt;
      p.theta += v.omega * dt;
    }
    this.scale += this.growth * dt;
  }

  discAdvance(stopped: () => boolean): Advance {
    const vmax = Math.max(...this.velocities.map((v) => Math.hypot(v.x, v.y)));
    // a disk piece scaled by `scale` has radius DISK_RADIUS * scale, which grows at DISK_RADIUS * growth
    const radius = this.scale * DISK_RADIUS;
    const radiusGrowth = this.growth * DISK_RADIUS;
    const horizon = (0.2 * radius) / (vmax + radiusGrowth);
    const reach = 2 * radius + 2 * (vmax + radiusGrowth) * horizon;
    const queue = new EventQueue();
    for (const [i, j] of horizonPairs(this.pieces, reach, stopped)) {
      if (stopped()) return { dt: 0, collision: false, repaired: false, failed: true };
      const time = discDiscTime(
        this.pieces[i],
        this.pieces[j],
        this.velocities[i],
        this.velocities[j],
        radius,
        radiusGrowth,
      );
      if (time <= horizon) queue.push({ time, i, j, edge: -1 });
    }
    for (let i = 0; i < this.pieces.length; i++) {
      if (stopped()) return { dt: 0, collision: false, repaired: false, failed: true };
      if (this.container.M === 0) {
        const time = discCircleWallTime(
          this.pieces[i],
          this.velocities[i],
          radius,
          radiusGrowth,
          this.container.size / 2,
        );
        if (time <= horizon) queue.push({ time, i, j: -1, edge: -1 });
      } else {
        const apothem = this.container.size * containerInradius(this.container.M);
        for (let edge = 0; edge < this.container.M; edge++) {
          const angle = this.container.phi - Math.PI / 2 + (2 * Math.PI * edge) / this.container.M;
          const time = discEdgeTime(
            this.pieces[i],
            this.velocities[i],
            radius,
            radiusGrowth,
            Math.cos(angle),
            Math.sin(angle),
            apothem,
          );
          if (time <= horizon) queue.push({ time, i, j: -1, edge });
        }
      }
    }
    const event = queue.pop();
    const dt = event?.time ?? horizon;
    const before = this.repairs;
    this.move(dt);
    this.operations++;
    if (event) {
      this.discImpulse(event);
      this.collisions++;
    }
    const valid = this.repair(stopped);
    return { dt, collision: !!event, repaired: before !== this.repairs, failed: !valid };
  }

  private discImpulse(event: Event): void {
    const p = this.pieces[event.i];
    const v = this.velocities[event.i];
    if (event.j >= 0) {
      const q = this.pieces[event.j];
      const distance = Math.hypot(p.x - q.x, p.y - q.y);
      collideDiscs(v, this.velocities[event.j], (p.x - q.x) / distance, (p.y - q.y) / distance, this.growth * DISK_RADIUS);
    } else {
      const angle = this.container.phi - Math.PI / 2 + (2 * Math.PI * event.edge) / this.container.M;
      const distance = Math.hypot(p.x, p.y);
      const nx = this.container.M === 0 ? (distance === 0 ? 1 : p.x / distance) : Math.cos(angle);
      const ny = this.container.M === 0 ? (distance === 0 ? 0 : p.y / distance) : Math.sin(angle);
      const closing = v.x * nx + v.y * ny + this.growth * DISK_RADIUS;
      // Tangency to a curved wall has outward second-order motion. A zero
      // normal impulse cannot resolve it; create microscopic room for the next event.
      if (this.container.M === 0 && Math.abs(closing) <= 1e-14 * Math.max(1, Math.hypot(v.x, v.y))) {
        this.scale *= 1 - 2e-14;
        this.repairs++;
      }
      const impulse = 2 * closing;
      v.x -= impulse * nx;
      v.y -= impulse * ny;
    }
  }

  polygonAdvance(maxStep: number, stopped: () => boolean): Advance {
    const steps = this.polygonSteps(maxStep, stopped);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /**
   * One polygon step as a generator that yields `work` after every feasibility probe, so a
   * caller can checkpoint inside a step that backs up to a contact (about 45 probes). The
   * probes, their order and the result are the same however the generator is driven.
   */
  *polygonSteps(maxStep: number, stopped: () => boolean): Generator<number, Advance> {
    const radius = boundingRadius(this.template.N);
    const closing =
      Math.max(...this.velocities.map((v) => Math.hypot(v.x, v.y) + radius * this.scale * Math.abs(v.omega))) +
      radius * this.growth;
    const dt = Math.min(maxStep, (0.025 * radius * this.scale) / closing);
    const base = this.pieces.map((p) => ({ ...p }));
    const scale = this.scale;
    const trial = (t: number): void => {
      this.scale = scale;
      for (let i = 0; i < base.length; i++) Object.assign(this.pieces[i], base[i]);
      this.move(t);
    };
    // Four substeps reduce transient rotation contacts missed by an endpoint-only test.
    let low = 0;
    let high = dt;
    let hit = false;
    for (let sample = 1; sample <= 4; sample++) {
      if (stopped()) return { dt: 0, collision: false, repaired: false, failed: true };
      trial((dt * sample) / 4);
      const free = this.feasible(this.scale, stopped);
      yield this.work;
      if (!free) {
        high = (dt * sample) / 4;
        hit = true;
        break;
      }
      low = (dt * sample) / 4;
    }
    if (hit) {
      for (let k = 0; k < 40; k++) {
        if (stopped()) return { dt: 0, collision: false, repaired: false, failed: true };
        const mid = (low + high) / 2;
        trial(mid);
        const free = this.feasible(this.scale, stopped);
        yield this.work;
        if (free) low = mid;
        else high = mid;
      }
      trial(high);
      const overlaps = findOverlaps(this.template.N, this.pieces, 0, this.scale);
      let wall: { i: number; nx: number; ny: number } | undefined;
      const container = this.unitContainer();
      for (let i = 0; i < this.pieces.length && overlaps.length === 0 && !wall; i++) {
        const p = this.pieces[i];
        visitContainerProtrusions(
          this.template.N,
          { ...p, x: p.x / this.scale, y: p.y / this.scale },
          container,
          (depth, nx, ny) => {
            if (depth > 0 && !wall) wall = { i, nx, ny };
          },
          true,
        );
      }
      trial(low);
      if (overlaps.length) {
        const { i, j } = overlaps[0];
        const contact = pieceSeparation(this.template.N, this.pieces[i], this.pieces[j], this.scale);
        const a = this.velocities[i];
        const b = this.velocities[j];
        const relative = (a.x - b.x) * contact.nx + (a.y - b.y) * contact.ny;
        // At zero growth the equal-mass central impulse conserves translation
        // energy and momentum. Rotation is reflected separately, without torque.
        if (relative < 2 * radius * this.growth) collideDiscs(a, b, contact.nx, contact.ny, radius * this.growth);
        a.omega = -a.omega;
        b.omega = -b.omega;
      } else if (wall) {
        const v = this.velocities[wall.i];
        const normal = v.x * wall.nx + v.y * wall.ny;
        if (normal + radius * this.growth > 0) {
          const impulse = 2 * (normal + radius * this.growth);
          v.x -= impulse * wall.nx;
          v.y -= impulse * wall.ny;
        }
        v.omega = -v.omega;
      }
      this.collisions++;
      // Locating the contact scanned the pieces about twice more.
      yield 2 * this.work;
    }
    this.operations++;
    const before = this.repairs;
    const valid = this.repair(stopped);
    return { dt: hit ? low : dt, collision: hit, repaired: before !== this.repairs, failed: !valid };
  }
}
