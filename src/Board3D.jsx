import * as THREE from "three";
import React, { useMemo, useRef, useEffect, Suspense } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";

const SQUARE_SIZE = 1;
const BOARD_OFFSET = 3.5; // centers an 8-wide board on the origin

// Adjust these to the exact filenames once you've unzipped the pack —
// itch.io doesn't expose them without downloading, so verify and rename
// this map to match what's actually in /public/models/chess/.
const MODEL_PATHS = {
  w: {
    k: "/models/chess/king_light.glb",
    q: "/models/chess/queen_light.glb",
    r: "/models/chess/rook_light.glb",
    b: "/models/chess/bishop_light.glb",
    n: "/models/chess/knight_light.glb",
    p: "/models/chess/pawn_light.glb",
  },
  b: {
    k: "/models/chess/king_dark.glb",
    q: "/models/chess/queen_dark.glb",
    r: "/models/chess/rook_dark.glb",
    b: "/models/chess/bishop_dark.glb",
    n: "/models/chess/knight_dark.glb",
    p: "/models/chess/pawn_dark.glb",
  },
};

// Relative proportions from the pack's own documentation, scaled against
// a king height chosen to look right against SQUARE_SIZE = 1.
const KING_HEIGHT = 0.85;
const PIECE_SCALE = { k: 1, q: 0.87, b: 0.7, n: 0.67, r: 0.6, p: 0.53 };

// Right-click-drag vertical lift: how far the whole board+pieces group can
// be raised/lowered (clamped to 25% of the board span), and how many
// dragged pixels correspond to one world unit of lift.
const BOARD_SPAN = 8 * SQUARE_SIZE; // full board width/depth
const MAX_LIFT = BOARD_SPAN * 0.25; // clamp vertical drag to 25% of board span, up or down
const LIFT_PIXELS_PER_UNIT = 120;   // drag sensitivity — higher = slower/finer movement

// Preload all 12 up front so the first render of a full board doesn't
// pop pieces in one by one as each mesh finishes loading.
Object.values(MODEL_PATHS).forEach((colorSet) =>
  Object.values(colorSet).forEach((path) => useGLTF.preload(path)),
);

function useIsolatedMaterials(scene) {
  const materials = useMemo(() => {
    const materials = [];
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      if (Array.isArray(obj.material)) {
        obj.material = obj.material.map((m) => {
          const clone = m.clone();
          clone.transparent = true;
          clone.emissive = new THREE.Color(0xfff2c9);
          materials.push(clone);
          return clone;
        });
      } else {
        obj.material = obj.material.clone();
        obj.material.transparent = true;
        obj.material.emissive = new THREE.Color(0xfff2c9);
        materials.push(obj.material);
      }
    });
    return materials;
  }, [scene]);

  useEffect(() => {
    return () => {
      materials.forEach((m) => m.dispose());
    };
  }, [materials]);

  return materials;
}

function DepartureGhost({ ghost, position }) {
  const { scene } = useGLTF(MODEL_PATHS[ghost.color][ghost.type]);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  const materials = useIsolatedMaterials(cloned);
  const scale = KING_HEIGHT * PIECE_SCALE[ghost.type];
  const yOffset = scale * 0.5;
  const startRef = useRef(performance.now());
  const DURATION = 2650; // matches 2D ghostFade

  useFrame(() => {
    const elapsed = performance.now() - startRef.current;
    const t = Math.min(1, elapsed / DURATION);
    const opacity = 0.55 * (1 - t);

    // Bright pop right at the start, decaying fast — draws the eye the
    // instant the piece begins to vanish, before the slower fade takes over.
    const FLASH_MS = 180;
    const flashT = Math.min(1, elapsed / FLASH_MS);
    const flashIntensity = 2.4 * (1 - flashT);

    materials.forEach((m) => {
      m.opacity = opacity;
      m.emissiveIntensity = flashIntensity;
    });
  });
  return (
    <primitive
      object={cloned}
      raycast={() => null}
      position={[position[0], yOffset, position[2]]}
      scale={[scale, scale, scale]}
      rotation={[0, ghost.color === "b" ? Math.PI : 0, 0]}
    />
  );
}

function CaptureGhost({ ghost, position }) {
  const { scene } = useGLTF(MODEL_PATHS[ghost.color][ghost.type]);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  const materials = useIsolatedMaterials(cloned);
  const scale = KING_HEIGHT * PIECE_SCALE[ghost.type];
  const baseY = scale * 0.5;
  const groupRef = useRef();
  const startRef = useRef(performance.now());
  const DURATION = 3900; // matches 2D captureFade

  useFrame(() => {
    const elapsed = performance.now() - startRef.current;
    const t = Math.min(1, elapsed / DURATION);
    const eased = 1 - Math.pow(1 - t, 2);

    const FLASH_MS = 180;
    const flashT = Math.min(1, elapsed / FLASH_MS);
    const flashIntensity = 2.4 * (1 - flashT);

    materials.forEach((m) => {
      m.opacity = 0.9 * (1 - eased);
      m.emissiveIntensity = flashIntensity;
    });

    if (groupRef.current) {
      groupRef.current.position.y = baseY + eased * 1.2;
      groupRef.current.position.x = position[0] + eased * 0.45;
      groupRef.current.rotation.z = eased * (Math.PI / 2);
    }
  });
  return (
    <group ref={groupRef} position={[position[0], baseY, position[2]]}>
      <primitive
        object={cloned}
        scale={[scale, scale, scale]}
        rotation={[0, ghost.color === "b" ? Math.PI : 0, 0]}
      />
    </group>
  );
}

function MoveArrow({ from, to, FILES, RANKS }) {
  const fromPos = squareToPosition(from, FILES, RANKS);
  const toPos = squareToPosition(to, FILES, RANKS);
  const dx = toPos[0] - fromPos[0];
  const dz = toPos[2] - fromPos[2];
  const length = Math.sqrt(dx * dx + dz * dz);
  const angle = Math.atan2(dx, dz);
  const midX = (fromPos[0] + toPos[0]) / 2;
  const midZ = (fromPos[2] + toPos[2]) / 2;

  const HEAD_LEN = 0.3;
  const shaftLength = Math.max(0.05, length - HEAD_LEN);
  const shaftCenterZ = -HEAD_LEN / 2;
  const headCenterZ = length / 2 - HEAD_LEN / 2;

  const groupRef = useRef();
  const startRef = useRef(performance.now());
  const DURATION = 5000; // same settle timing as DestinationOutline

  useFrame(() => {
    const t = Math.min(1, (performance.now() - startRef.current) / DURATION);
    // Fades all the way to 0, unlike the destination outline — the arrow
    // is a directional cue meant to be transient, not a persistent marker.
    const opacity = 0.85 * (1 - t);
    if (groupRef.current) {
      groupRef.current.traverse((obj) => {
        if (obj.material) obj.material.opacity = opacity;
      });
    }
  });

  if (length < 0.01) return null; // no visible arrow for a null move

  return (
    <group
      ref={groupRef}
      position={[midX, 0.022, midZ]}
      rotation={[0, angle, 0]}
    >
      <mesh position={[0, 0, shaftCenterZ]}>
        <boxGeometry args={[0.06, 0.015, shaftLength]} />
        <meshBasicMaterial color="#7e7666" transparent opacity={0.5} />
      </mesh>
      <mesh position={[0, 0, headCenterZ]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.12, HEAD_LEN, 8]} />
        <meshBasicMaterial color="#2b422c" transparent opacity={0.85} />
      </mesh>
    </group>
  );
}

function DestinationOutline({ position }) {
  const lineRef = useRef();
  const startRef = useRef(performance.now());
  const DURATION = 3500; // matches 2D slowFadeTo's timing

  const geometry = useMemo(
    () =>
      new THREE.EdgesGeometry(
        new THREE.PlaneGeometry(SQUARE_SIZE * 0.92, SQUARE_SIZE * 0.92),
      ),
    [],
  );

  useFrame(() => {
    if (!lineRef.current) return;
    const elapsed = performance.now() - startRef.current;
    const t = Math.min(1, elapsed / DURATION);
    // Eases from a bright 0.9 down to a persistent 0.45 — never fades to
    // zero, matching how the 2D board keeps the last move visibly marked.
    lineRef.current.material.opacity = 0.45 + 0.45 * (1 - t);
  });

  return (
    <lineSegments
      ref={lineRef}
      geometry={geometry}
      position={[position[0], 0.015, position[2]]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <lineBasicMaterial color="#ffffff" transparent opacity={0.9} />
    </lineSegments>
  );
}

// Same square-naming logic as the 2D board — file/rank in, x/z world position out.
function squareToPosition(sq, files, ranks) {
  const fileIdx = files.indexOf(sq[0]);
  const rankIdx = ranks.indexOf(parseInt(sq[1], 10));
  return [
    (fileIdx - BOARD_OFFSET) * SQUARE_SIZE,
    0,
    (rankIdx - BOARD_OFFSET) * SQUARE_SIZE,
  ];
}

// Invisible helper: listens for right-click-drag on the canvas and reports
// the per-frame vertical pixel delta upward via onDelta. Renders nothing —
// it only owns the pointer/context-menu event wiring on the canvas DOM
// element, kept separate from any visible mesh.
function RightDragLift({ onDelta }) {
  const { gl } = useThree();
  const draggingRef = useRef(false);
  const lastYRef = useRef(0);

  useEffect(() => {
    const dom = gl.domElement;

    function onContextMenu(e) {
      e.preventDefault(); // suppress the browser's right-click menu, only over the canvas
    }
    function onPointerDown(e) {
      if (e.button !== 2) return; // right mouse button only
      draggingRef.current = true;
      lastYRef.current = e.clientY;
    }
    function onPointerMove(e) {
      if (!draggingRef.current) return;
      const deltaPx = lastYRef.current - e.clientY; // dragging up = positive lift
      lastYRef.current = e.clientY;
      onDelta(deltaPx);
    }
    function onPointerUp(e) {
      if (e.button === 2) draggingRef.current = false;
    }

    dom.addEventListener("contextmenu", onContextMenu);
    dom.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      dom.removeEventListener("contextmenu", onContextMenu);
      dom.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [gl, onDelta]);

  return null;
}

function Square({
  sq,
  position,
  light,
  selected,
  isCheckedKing,
  onClick,
  onDrop,
}) {
  return (
    <mesh
      position={[position[0], 0, position[2]]}
      rotation={[-Math.PI / 2, 0, 0]}
      onClick={onClick}
      onPointerUp={onDrop}
    >
      <planeGeometry args={[SQUARE_SIZE * 0.98, SQUARE_SIZE * 0.98]} />
      <meshStandardMaterial
        color={selected ? "#b08d57" : light ? "#ae9e79" : "#7c6448"}
        emissive={isCheckedKing ? "#dc1414" : "#000000"}
        emissiveIntensity={isCheckedKing ? 0.5 : 0}
      />
    </mesh>
  );
}

// Primitive stand-ins — swapped for real GLTF meshes once the toggle and
// interaction are confirmed working end-to-end.
const PIECE_GEOMETRY = {
  p: <cylinderGeometry args={[0.18, 0.22, 0.35, 16]} />,
  r: <boxGeometry args={[0.32, 0.4, 0.32]} />,
  n: <coneGeometry args={[0.22, 0.5, 8]} />,
  b: <coneGeometry args={[0.2, 0.55, 16]} />,
  q: <cylinderGeometry args={[0.24, 0.28, 0.6, 16]} />,
  k: <cylinderGeometry args={[0.24, 0.3, 0.65, 16]} />,
};

function Piece({ piece, position, tilted, onClick, onDrop }) {
  const { scene } = useGLTF(MODEL_PATHS[piece.color][piece.type]);
  // Each usage needs its own clone — drei caches and shares the loaded
  // scene, so without cloning every pawn on the board would be the same
  // Object3D instance and move/rotate together.
  const cloned = useMemo(() => scene.clone(true), [scene]);
  const scale = KING_HEIGHT * PIECE_SCALE[piece.type];
  const yOffset = scale * 0.5;
  return (
    <primitive
      object={cloned}
      position={[position[0], yOffset, position[2]]}
      scale={[scale, scale, scale]}
      rotation={[
        tilted ? Math.PI / 2 : 0,
        piece.color === "b" ? Math.PI : 0, // pack's own note: knight faces +Z, flip black's side
        0,
      ]}
      onClick={onClick}
      onPointerUp={onDrop}
    />
  );
}

export default function Board3D({
  board,
  FILES,
  RANKS,
  selected,
  flash,
  gameStatus,
  pickSquare,
  onDrop,
  fileIdx,
}) {
  // Looks up the piece that just vacated a given square (departure ghost),
  // if any — same lookup the 2D board already does per-square.
  function ghostAt(sq, piece) {
    return !piece && flash && flash.ghosts?.find((g) => g.sq === sq);
  }

  const squares = useMemo(() => {
    const list = [];
    for (const r of RANKS) {
      for (const f of FILES) {
        const sq = f + r;
        list.push({ sq, light: (fileIdx(sq) + r) % 2 === 0 });
      }
    }
    return list;
  }, [FILES, RANKS, fileIdx]);

  // Whole-board vertical lift, driven by right-click-drag (RightDragLift
  // below). boardGroupRef wraps every square/piece/effect so they all
  // translate together as one rigid unit; liftRef holds the current lift
  // value across renders without needing a React state update per pixel.
  const boardGroupRef = useRef();
  const liftRef = useRef(0);

  function handleLiftDelta(deltaPx) {
    liftRef.current = Math.max(
      -MAX_LIFT,
      Math.min(MAX_LIFT, liftRef.current + deltaPx / LIFT_PIXELS_PER_UNIT),
    );
    if (boardGroupRef.current) boardGroupRef.current.position.y = liftRef.current;
  }

  return (
    <Canvas
      shadows
      camera={{ position: [0, 8, 6], fov: 45 }}
      style={{
        width: "100%",
        height: 560,
        background: "#4a4137",
        borderRadius: 4,
      }}
    >
      <ambientLight intensity={0.9} />
      <directionalLight position={[5, 10, 5]} intensity={1.6} castShadow />
      <OrbitControls
        enablePan={false}
        minPolarAngle={0.3}
        maxPolarAngle={Math.PI / 2.3}
        minDistance={4}
        maxDistance={14}
      />
      <RightDragLift onDelta={handleLiftDelta} />
      <Suspense fallback={null}>
        <group ref={boardGroupRef}>
          {flash?.moveArrow && (
            <MoveArrow
              key={"arrow-" + flash.id}
              from={flash.moveArrow.from}
              to={flash.moveArrow.to}
              FILES={FILES}
              RANKS={RANKS}
            />
          )}{" "}
          {squares.map(({ sq, light }) => {
            const position = squareToPosition(sq, FILES, RANKS);
            const piece = board[sq];
            const ghost = ghostAt(sq, piece);
            const isTo = flash && flash.toSquares?.includes(sq);
            const isCheckedKing =
              piece &&
              piece.type === "k" &&
              (gameStatus?.type === "check" ||
                gameStatus?.type === "checkmate") &&
              piece.color === gameStatus.checkedColor;
            const isMatedKing =
              piece &&
              piece.type === "k" &&
              gameStatus?.type === "checkmate" &&
              piece.color === gameStatus.checkedColor;

            const handleClick = (e) => {
              e?.stopPropagation?.();
              pickSquare(sq);
            };

            const handleDrop = (e) => {
              e?.stopPropagation?.();
              onDrop(sq);
            };

            return (
              <group key={sq}>
                <Square
                  sq={sq}
                  position={position}
                  light={light}
                  selected={selected === sq}
                  isCheckedKing={isCheckedKing}
                  onClick={handleClick}
                  onDrop={handleDrop}
                />
                {piece && (
                  <Piece
                    piece={piece}
                    position={position}
                    tilted={isMatedKing}
                    onClick={handleClick}
                    onDrop={handleDrop}
                  />
                )}
                {ghost && (
                  <DepartureGhost
                    key={"ghost-" + flash.id + sq}
                    ghost={ghost}
                    position={position}
                  />
                )}
                {flash?.captureGhost?.sq === sq && (
                  <CaptureGhost
                    key={"capture-" + flash.id}
                    ghost={flash.captureGhost}
                    position={position}
                  />
                )}
                {isTo && (
                  <DestinationOutline
                    key={"outline-" + flash.id + sq}
                    position={position}
                  />
                )}
              </group>
            );
          })}
        </group>
      </Suspense>
    </Canvas>
  );
}