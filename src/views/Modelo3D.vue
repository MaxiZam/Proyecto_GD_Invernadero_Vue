<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useInvernadero } from '../composables/useInvernadero'

const { telemetria, sinDatos } = useInvernadero()

const contenedor3D = ref<HTMLElement | null>(null)
const modeloContenedor = ref<HTMLElement | null>(null)
const modeloCargado = ref(false)
const errorModelo = ref(false)

const COLORES = {
  AZUL_ACTIVO: '#007bff',
  GRIS_INACTIVO: '#6c757d',
  TIERRA: '#8B5A2B',
  ESTRUCTURA: '#ffffff'
}

// --- Actuadores que cambian de color según su estado ---
type ClaveActuador = 'caloventor' | 'humidificador' | 'bomba'
const ACTUADORES_COLOR: Record<ClaveActuador, string[]> = {
  caloventor: ['materialcaloventor'],
  humidificador: ['materialhumidificador'],
  bomba: ['bombadeagua']
}
const CLAVES_ACTUADOR = Object.keys(ACTUADORES_COLOR) as ClaveActuador[]

// Materiales
const materialesActuador: Record<ClaveActuador, THREE.MeshStandardMaterial[]> = {
  caloventor: [], humidificador: [], bomba: []
}

// --- Aspecto del modelo ---
const CONSERVAR_COLOR: string[] = ['ventanal', 'persiana']
const BLANQUEAR_TRANSPARENTES = true
const COLOR_FONDO = 0x2f3237
const INTENSIDAD = { dia: 2.0, noche: 0.4, ambiente: 1.2, relleno: 1.0 }
// --------------------------

// --- Ajustes de invernadero.glb ---
const EJE_PERSIANAS: 'x' | 'y' | 'z' = 'y'
const ESCALA_PERSIANA_RECOGIDA = 0.05
const ANGULOS = {
  izquierdo: { abierto: 0, cerrado: -Math.PI / 4 },
  derecho: { abierto: Math.PI, cerrado: Math.PI * 1.25 }
} as const
// --------------------------

let scene!: THREE.Scene
let camera!: THREE.PerspectiveCamera
let renderer!: THREE.WebGLRenderer
let controls!: OrbitControls
let luzDireccional: THREE.DirectionalLight | undefined
let animationFrameId = 0
let resizeObserver: ResizeObserver | undefined

const ventanasMeshes: THREE.Object3D[] = []
const persianasMeshes: THREE.Object3D[] = []
const escalaBasePersianas = new Map<string, number>()

const num = (v: number, decimales = 1) => (sinDatos.value ? '--' : v.toFixed(decimales))

const toggleFullscreen = () => {
  if (!document.fullscreenElement) {
    modeloContenedor.value?.requestFullscreen().catch(err => {
      console.error(`Error al intentar modo pantalla completa: ${err.message}`)
    })
  } else {
    document.exitFullscreen()
  }
}

// --- Colores de actuadores ---
const actualizarColores = () => {
  const activo: Record<ClaveActuador, boolean> = {
    caloventor: telemetria.caloventorActivo,
    humidificador: telemetria.humidificadorActivo,
    bomba: telemetria.bombaActiva
  }
  for (const clave of CLAVES_ACTUADOR) {
    const color = activo[clave] ? COLORES.AZUL_ACTIVO : COLORES.GRIS_INACTIVO
    for (const mat of materialesActuador[clave]) mat.color.set(color)
  }
}

watch(
  [() => telemetria.caloventorActivo, () => telemetria.humidificadorActivo, () => telemetria.bombaActiva],
  actualizarColores
)

// --- Materiales del modelo ---
interface Informe { malla: string; material: string; tratamiento: string }

const normalizar = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')

/** Nombres normalizados de la malla y de todos sus nodos padre */
const nombresJerarquia = (obj: THREE.Object3D): string[] => {
  const nombres: string[] = []
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) nombres.push(normalizar(o.name))
  return nombres
}

const detectarActuador = (mesh: THREE.Mesh, mat: THREE.Material): ClaveActuador | null => {
  const nombres = [normalizar(mat.name), ...nombresJerarquia(mesh)]
  for (const clave of CLAVES_ACTUADOR) {
    if (ACTUADORES_COLOR[clave].some(k => nombres.some(n => n.includes(k)))) return clave
  }
  return null
}

/**
 * Decide el color de cada material. Todos se clonan por malla
 */
const prepararMaterial = (mat: THREE.Material, mesh: THREE.Mesh, informe: Informe[]): THREE.Material => {
  const nombreMalla = mesh.name.toLowerCase()
  const nombreMat = mat.name.toLowerCase()

  const m = mat.clone()
  const std = m as THREE.MeshStandardMaterial

  const actuador = detectarActuador(mesh, mat)
  const esTierra = nombreMalla.includes('tierra') || nombreMat.includes('tierra')
  const conservar = CONSERVAR_COLOR.some(k => nombreMalla.includes(k) || nombreMat.includes(k))

  let tratamiento: string

  if (actuador) {
    materialesActuador[actuador].push(std)
    tratamiento = `actuador: ${actuador} (color según estado)`
  } else if (esTierra) {
    std.color?.set(COLORES.TIERRA)
    tratamiento = 'tierra'
  } else if (conservar) {
    tratamiento = 'conserva color original'
  } else if (BLANQUEAR_TRANSPARENTES || m.opacity >= 1) {
    std.color?.set(COLORES.ESTRUCTURA)
    std.map = null
    tratamiento = 'blanco'
  } else {
    tratamiento = 'transparente (color original)'
  }

  m.side = THREE.DoubleSide
  if (m.opacity < 1) {
    m.transparent = true
    m.depthWrite = false
  }
  m.needsUpdate = true

  informe.push({ malla: mesh.name, material: mat.name, tratamiento })
  return m
}

// --- Carga del modelo ---
const cargarModelo = () => {
  new GLTFLoader().load('/invernadero.glb', (gltf) => {
    const modelo = gltf.scene
    const informe: Informe[] = []

    modelo.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return

      const original = mesh.material
      mesh.material = Array.isArray(original)
        ? original.map(m => prepararMaterial(m, mesh, informe))
        : prepararMaterial(original, mesh, informe)

      const nombre = mesh.name.toLowerCase()
      if (nombre.includes('ventanal')) ventanasMeshes.push(mesh)
      if (nombre.includes('persiana')) {
        persianasMeshes.push(mesh)
        escalaBasePersianas.set(mesh.uuid, mesh.scale[EJE_PERSIANAS])
      }
    })

    console.info(`[3D] ventanales: ${ventanasMeshes.length}, persianas: ${persianasMeshes.length}, ` +
      `materiales con color de estado -> caloventor: ${materialesActuador.caloventor.length}, ` +
      `humidificador: ${materialesActuador.humidificador.length}, bomba: ${materialesActuador.bomba.length}`)
    console.table(informe)   // qué se hizo con cada pieza del modelo
    for (const clave of CLAVES_ACTUADOR) {
      if (materialesActuador[clave].length === 0) {
        console.warn(`[3D] No se encontró ninguna pieza para "${clave}". Revisa la tabla de arriba y ` +
          `ajusta ACTUADORES_COLOR con el nombre real de su malla o material.`)
      }
    }

    modelo.position.set(0, -1, 0)
    scene.add(modelo)
    actualizarColores()
    modeloCargado.value = true
  }, undefined, (error) => {
    console.error('Error al cargar el modelo GLB:', error)
    errorModelo.value = true
    modeloCargado.value = true
  })
}

// --- Escena ---
const ajustarTamano = () => {
  const cont = contenedor3D.value
  if (!cont || !renderer) return
  const w = cont.clientWidth, h = cont.clientHeight
  if (w === 0 || h === 0) return
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}

const animar = () => {
  animationFrameId = requestAnimationFrame(animar)

  for (const v of ventanasMeshes) {
    const n = v.name.toLowerCase()
    const lado = n.includes('izquierdo') ? 'izquierdo' : n.includes('derecho') ? 'derecho' : null
    if (!lado) continue
    const objetivo = ANGULOS[lado][telemetria.ventanalesAbiertos ? 'abierto' : 'cerrado']
    v.rotation.x = THREE.MathUtils.lerp(v.rotation.x, objetivo, 0.05)
  }

  for (const p of persianasMeshes) {
    const base = escalaBasePersianas.get(p.uuid) ?? 1
    // enrolladas = recogidas = entra la luz
    const objetivo = telemetria.persianasEnrolladas ? base * ESCALA_PERSIANA_RECOGIDA : base
    p.scale[EJE_PERSIANAS] = THREE.MathUtils.lerp(p.scale[EJE_PERSIANAS], objetivo, 0.05)
  }

  if (luzDireccional) {
    const objetivo = telemetria.esDeDia ? INTENSIDAD.dia : INTENSIDAD.noche
    luzDireccional.intensity = THREE.MathUtils.lerp(luzDireccional.intensity, objetivo, 0.02)
  }

  controls.update()
  renderer.render(scene, camera)
}

const iniciarEscena = () => {
  const cont = contenedor3D.value
  if (!cont) return

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true })
  } catch (e) {
    console.error('WebGL no disponible:', e)
    errorModelo.value = true
    modeloCargado.value = true
    return
  }

  const ancho = cont.clientWidth || 800
  const alto = cont.clientHeight || 500

  scene = new THREE.Scene()
  scene.background = new THREE.Color(COLOR_FONDO)

  camera = new THREE.PerspectiveCamera(75, ancho / alto, 0.1, 1000)
  camera.position.set(0, 2, 5)

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(ancho, alto)
  cont.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.05

  // Luz principal
  luzDireccional = new THREE.DirectionalLight(0xffffff, INTENSIDAD.dia)
  luzDireccional.position.set(5, 10, 5)
  const luzRelleno = new THREE.DirectionalLight(0xffffff, INTENSIDAD.relleno)
  luzRelleno.position.set(-6, 4, -5)
  scene.add(luzDireccional, luzRelleno, new THREE.AmbientLight(0xffffff, INTENSIDAD.ambiente))

  resizeObserver = new ResizeObserver(ajustarTamano)   // cubre ventana, layout y pantalla completa
  resizeObserver.observe(cont)

  cargarModelo()
  animar()
}

onMounted(iniciarEscena)

onUnmounted(() => {
  cancelAnimationFrame(animationFrameId)
  resizeObserver?.disconnect()
  controls?.dispose()
  scene?.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.geometry.dispose()
    ;(Array.isArray(m.material) ? m.material : [m.material]).forEach(x => x.dispose())
  })
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <div>
    <div class="content-header">
      <div class="container-fluid">
        <div class="row mb-2 mt-2">
          <div class="col-sm-8">
            <h1 class="m-0 text-dark font-weight-bold">
              Monitoreo en Tiempo Real
              <span v-if="!sinDatos" class="badge ml-2" :class="telemetria.esDeDia ? 'badge-warning' : 'badge-dark'">
                <i :class="['fas', telemetria.esDeDia ? 'fa-sun' : 'fa-moon', 'mr-1']"></i>
                {{ telemetria.esDeDia ? 'Día' : 'Noche' }}
              </span>
            </h1>
          </div>
        </div>
      </div>
    </div>

    <div v-if="sinDatos" class="alert alert-warning shadow-sm">
      <i class="fas fa-plug mr-2"></i>
      Sin datos en tiempo real. Verifica que el backend y el simulador estén en ejecución.
    </div>

    <div class="row mt-3">
      <div class="col-lg-3 col-md-4">

        <div class="small-box bg-success shadow-sm mb-3">
          <div class="inner">
            <h3>{{ num(telemetria.temperatura) }}<sup style="font-size: 20px">°C</sup></h3>
            <p>Temperatura Interior</p>
          </div>
          <div class="icon"><i class="fas fa-thermometer-half"></i></div>
        </div>

        <div class="small-box bg-white border border-success shadow-sm mb-3">
          <div class="inner text-success">
            <h3>{{ num(telemetria.humedadAire) }}<sup style="font-size: 20px">%</sup></h3>
            <p class="text-dark font-weight-bold">Humedad del Aire</p>
          </div>
          <div class="icon"><i class="fas fa-tint text-success"></i></div>
        </div>

        <div class="small-box bg-white border border-success shadow-sm mb-3">
          <div class="inner text-success">
            <h3>{{ num(telemetria.humedadSuelo) }}<sup style="font-size: 20px">%</sup></h3>
            <p class="text-dark font-weight-bold">Humedad del Suelo</p>
          </div>
          <div class="icon"><i class="fas fa-seedling text-success"></i></div>
        </div>

        <div class="small-box bg-success shadow-sm mb-4">
          <div class="inner">
            <h3>{{ num(telemetria.luminosidad, 0) }}<sup style="font-size: 20px"> Lux</sup></h3>
            <p>Luminosidad</p>
          </div>
          <div class="icon"><i class="fas fa-sun"></i></div>
        </div>

        <div class="card card-outline card-success shadow-sm">
          <div class="card-header bg-white">
            <h3 class="card-title font-weight-bold">Estado Actuadores</h3>
          </div>
          <div class="card-body p-0">
            <ul class="list-group list-group-flush">
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Caloventor
                <span class="badge" :class="telemetria.caloventorActivo ? 'bg-success' : 'bg-secondary'">
                  {{ telemetria.caloventorActivo ? 'ON' : 'OFF' }}
                </span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Ventanales
                <span class="badge" :class="telemetria.ventanalesAbiertos ? 'bg-success' : 'bg-secondary'">
                  {{ telemetria.ventanalesAbiertos ? 'ABIERTOS' : 'CERRADOS' }}
                </span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Persianas
                <span class="badge" :class="telemetria.persianasEnrolladas ? 'bg-success' : 'bg-secondary'">
                  {{ telemetria.persianasEnrolladas ? 'ENROLLADAS' : 'DESENROLLADAS' }}
                </span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Bomba de Agua
                <span class="badge" :class="telemetria.bombaActiva ? 'bg-primary' : 'bg-secondary'">
                  {{ telemetria.bombaActiva ? 'ACTIVA' : 'INACTIVA' }}
                </span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Humidificador
                <span class="badge" :class="telemetria.humidificadorActivo ? 'bg-success' : 'bg-secondary'">
                  {{ telemetria.humidificadorActivo ? 'ON' : 'OFF' }}
                </span>
              </li>
            </ul>
          </div>
        </div>

      </div>

      <div class="col-lg-9 col-md-8">
        <div class="card card-outline card-success shadow model-card h-100">
          <div class="card-header bg-white d-flex justify-content-between align-items-center">
            <h3 class="card-title font-weight-bold m-0">
              <i class="fas fa-video mr-2 text-success"></i>
              Renderizado 3D Interactivo
            </h3>
            <div class="card-tools">
              <button type="button" class="btn btn-tool" @click="toggleFullscreen">
                <i class="fas fa-expand"></i>
              </button>
            </div>
          </div>

          <div class="card-body p-0 canvas-container" ref="modeloContenedor">
            <div ref="contenedor3D" class="visor-3d"></div>
            <div class="placeholder-3d" v-if="!modeloCargado">
              <i class="fas fa-cube fa-spin fa-3x text-success mb-3"></i>
              <h5 class="text-white">Cargando Gemelo Digital...</h5>
            </div>
            <div class="placeholder-3d" v-if="errorModelo">
              <h5 class="text-white">No se pudo cargar el modelo 3D (/invernadero.glb o WebGL)</h5>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-card {
  border-radius: 10px;
  overflow: hidden;
  min-height: 65vh;
}

.canvas-container {
  height: 100%;
  min-height: 50vh;
  position: relative;
  background: radial-gradient(circle, #3a3a3a 0%, #1a1a1a 100%);
}

.canvas-container:fullscreen {
  height: 100vh;
  width: 100vw;
}

.visor-3d {
  position: absolute;
  inset: 0;
  overflow: hidden;
  cursor: grab;
}

.placeholder-3d {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
</style>