import {
  Component,
  signal,
  AfterViewInit,
  OnDestroy,
  inject,
  PLATFORM_ID,
  ViewChild,
  ElementRef,
  ViewEncapsulation,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { isPlatformBrowser } from '@angular/common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrls: ['./app.css'],
  encapsulation: ViewEncapsulation.None,
})
export class App implements AfterViewInit, OnDestroy {
  protected readonly title = signal('portfolio-me');
  private platformId = inject(PLATFORM_ID);

  @ViewChild('auroraCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  // Aurora
  private gl!: WebGLRenderingContext;
  private program!: WebGLProgram;
  private auroraRafId = 0;
  private startTime = 0;
  private mouseX = 0.5;
  private mouseY = 0.5;
  private targetMouseX = 0.5;
  private targetMouseY = 0.5;

  // Three.js
  private threeRenderer: any = null;
  private threeRafId = 0;
  private parallaxTargetX = 0;
  private parallaxTargetY = 0;
  private parallaxCurrentX = 0;
  private parallaxCurrentY = 0;
  private autoRotY = 0;

  private typingTimeout: ReturnType<typeof setTimeout> | null = null;
  private scrollObserver!: IntersectionObserver;

  private readonly VERT = `attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0.,1.);}`;
  private readonly FRAG = `
    precision mediump float;
    uniform vec2 u_res;uniform float u_time;uniform vec2 u_mouse;
    vec2 hash2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return fract(sin(p)*43758.5453);}
    float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);return mix(mix(dot(hash2(i)*2.-1.,f),dot(hash2(i+vec2(1,0))*2.-1.,f-vec2(1,0)),u.x),mix(dot(hash2(i+vec2(0,1))*2.-1.,f-vec2(0,1)),dot(hash2(i+vec2(1,1))*2.-1.,f-vec2(1,1)),u.x),u.y)*.5+.5;}
    float fbm(vec2 p){float v=0.,a=.5;mat2 r=mat2(.8776,.4794,-.4794,.8776);for(int i=0;i<4;i++){v+=a*noise(p);p=r*p*2.1+vec2(1.7,9.2);a*=.5;}return v;}
    float warp(vec2 p,float t){vec2 q=vec2(fbm(p+t*.07),fbm(p+vec2(5.2,1.3)+t*.05));return fbm(p+3.5*q+t*.03);}
    vec3 pal(float t,float s){return vec3(.40,.32,.68)+vec3(.36,.26,.36)*cos(6.28318*(vec3(1.)*(t+s)+vec3(0.,.15,.45)));}
    void main(){
      vec2 uv=(gl_FragCoord.xy-.5*u_res)/min(u_res.x,u_res.y);
      uv+=(u_mouse-.5)*.10;
      float t=u_time*.22;
      vec3 col=pal(warp(uv*1.1+vec2(0.,t*.3),t),0.)*.5;
      col+=pal(warp(uv*1.7+vec2(t*.12,-t*.2),t*1.2),.38)*pow(1.-smoothstep(0.,.5,abs(uv.y+sin(uv.x*1.6+t)*.16)),1.6)*1.3;
      float vig=1.-smoothstep(.5,1.35,length(uv*1.05));col*=vig*vig;
      col=mix(vec3(.01,.007,.035),col,.85);col=col/(col+.9);col=pow(col,vec3(.9));
      gl_FragColor=vec4(col,1.);
    }
  `;

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.initAurora();
    this.initTypewriter();
    this.bindMouse();
    this.initScrollAnimations();
    this.initThree();
  }

  ngOnDestroy(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    cancelAnimationFrame(this.auroraRafId);
    cancelAnimationFrame(this.threeRafId);
    if (this.typingTimeout) clearTimeout(this.typingTimeout);
    if (this.scrollObserver) this.scrollObserver.disconnect();
    if (this.threeRenderer) this.threeRenderer.dispose();
    window.removeEventListener('mousemove', this.onMouse);
    window.removeEventListener('resize', this.onResize);
  }

  navScrollTo(id: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    const p = this.findScrollParent();
    p.scrollTo({ top: p.scrollTop + el.getBoundingClientRect().top - p.getBoundingClientRect().top, behavior: 'smooth' });
  }
  private findScrollParent(): HTMLElement {
    for (const el of [document.documentElement, document.body, document.querySelector('app-root') as HTMLElement])
      if (el?.scrollHeight > el?.clientHeight) return el;
    return document.documentElement;
  }

  // ── Aurora ────────────────────────────────────────────────────────────────
  private initAurora(): void {
    const canvas = this.canvasRef.nativeElement;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false }) as WebGLRenderingContext;
    if (!gl) return;
    this.gl = gl;
    const mk = (t: number, s: string) => { const sh = gl.createShader(t)!; gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, this.VERT));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, this.FRAG));
    gl.linkProgram(prog); this.program = prog; gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.startTime = performance.now();
    this.resizeAurora();
    this.renderAurora();
  }
  private resizeAurora(): void {
    const c = this.canvasRef?.nativeElement;
    if (!c || !this.gl) return;
    const sc = Math.min(window.devicePixelRatio, 1.5) * 0.6;
    c.width = Math.floor(window.innerWidth * sc);
    c.height = Math.floor(window.innerHeight * sc);
    this.gl.viewport(0, 0, c.width, c.height);
  }
  private renderAurora = (): void => {
    const gl = this.gl, t = (performance.now() - this.startTime) * .001, c = this.canvasRef.nativeElement;
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_res'), c.width, c.height);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_time'), t);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_mouse'), this.mouseX, this.mouseY);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.auroraRafId = requestAnimationFrame(this.renderAurora);
  };

  // ── Three.js ──────────────────────────────────────────────────────────────
  private async initThree(): Promise<void> {
    try {
      await this.loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');
      await this.loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/OBJLoader.js');
    } catch (e) { return; }

    const THREE = (window as any).THREE;
    if (!THREE?.OBJLoader) return;

    // ── Use the EXISTING model-canvas from the HTML ──────────────────────
    const canvas = document.querySelector<HTMLCanvasElement>('.model-canvas');
    if (!canvas) return;

    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width  = W;
    canvas.height = H;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(W, H, false);
    this.threeRenderer = renderer;

    const scene = new THREE.Scene();

    // ── Camera: wide FOV, positioned centrally, looks at world origin ────
    // We shift the GROUP to the right in world space instead of using
    // setViewOffset (which has unintuitive axis directions).
    // At z=4.5, FOV=50, the visible horizontal half-width ≈ 4.5*tan(25°)≈2.1
    // Placing the group at x=+1.1 puts it in the right ~45% of screen.
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
    camera.position.set(0, 0.1, 4.5);
    camera.lookAt(0, 0, 0);

    // ── Lights ────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xd4c8ff, 4.5);
    key.position.set(-2, 3, 4); scene.add(key);
    const cyan = new THREE.DirectionalLight(0x22d3ee, 2.5);
    cyan.position.set(3, 1, 2); scene.add(cyan);
    const purple = new THREE.DirectionalLight(0x8b5cf6, 2.0);
    purple.position.set(-1, -3, -3); scene.add(purple);
    const pink = new THREE.DirectionalLight(0xf472b6, 0.7);
    pink.position.set(0, -4, 2); scene.add(pink);

    // ── Model group — pushed RIGHT in world space ─────────────────────────
    // FOV=50, z=4.5 → visible half-width ≈ 2.1 units
    // x=+1.4 puts it in the rightmost ~30% of the screen
    const group = new THREE.Group();
    group.position.set(1.4, 0.0, 0);
    group.rotation.x =  0.05;   // very slight forward tilt
    group.rotation.y = -0.5;    // 3/4 angle
    scene.add(group);

    // ── Render loop ───────────────────────────────────────────────────────
    const LERP = 0.065;
    const tick = () => {
      this.threeRafId = requestAnimationFrame(tick);
      this.autoRotY += 0.005;
      this.parallaxCurrentX += (this.parallaxTargetX - this.parallaxCurrentX) * LERP;
      this.parallaxCurrentY += (this.parallaxTargetY - this.parallaxCurrentY) * LERP;

      group.rotation.y = -0.5 + Math.sin(this.autoRotY) * 0.3 + this.parallaxCurrentX * 0.55;
      group.rotation.x =  0.05 + this.parallaxCurrentY * 0.32;
      group.position.x = 1.4 + this.parallaxCurrentX * 0.1;
      group.position.y = 0.0 + Math.sin(this.autoRotY * 0.8) * 0.05 + this.parallaxCurrentY * 0.07;

      renderer.render(scene, camera);
    };
    tick();

    // ── Textures ─────────────────────────────────────────────────────────
    const tl = new THREE.TextureLoader();
    const tex = (u: string): Promise<any> => new Promise(r => tl.load(u, r, undefined, () => r(null)));
    const [albedo, ao, nrm, rough] = await Promise.all([
      tex('Among_Us_Guy_Albedo.png'),
      tex('Among_Us_Guy_AO.png'),
      tex('Among_Us_Guy_Normal.png'),
      tex('Among_Us_Guy_Roughness.png'),
    ]);
    if (albedo) albedo.encoding = THREE.sRGBEncoding;

    const mat = new THREE.MeshStandardMaterial({
      map: albedo ?? undefined,
      aoMap: ao ?? undefined, aoMapIntensity: 1.0,
      normalMap: nrm ?? undefined, normalScale: new THREE.Vector2(1.2, 1.2),
      roughnessMap: rough ?? undefined,
      roughness: 0.75, metalness: 0.2,
      transparent: true, opacity: 0,
    });

    // ── OBJ ──────────────────────────────────────────────────────────────
    new THREE.OBJLoader().load(
      'Among%20Us%20Guy_-_Sketchfab.obj',
      (obj: any) => {
        obj.traverse((c: any) => {
          if (!c.isMesh) return;
          c.material = mat;
          const uv = c.geometry.attributes['uv'];
          if (uv) c.geometry.setAttribute('uv2', uv);
        });
        const box = new THREE.Box3().setFromObject(obj);
        const sz = new THREE.Vector3(), ctr = new THREE.Vector3();
        box.getSize(sz); box.getCenter(ctr);
        const s = 2.4 / Math.max(sz.x, sz.y, sz.z);
        obj.scale.setScalar(s);
        obj.position.set(-ctr.x * s, -ctr.y * s, -ctr.z * s);
        group.add(obj);

        let f = 0;
        const fade = () => {
          f++;
          const t = Math.min(f / 90, 1);
          mat.opacity = t * t * (3 - 2 * t);
          if (f < 90) requestAnimationFrame(fade);
          else { mat.transparent = false; mat.opacity = 1; mat.needsUpdate = true; }
        };
        fade();
      },
      undefined,
      () => {
        const geo = new THREE.IcosahedronGeometry(1, 1);
        group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x6c63ff, roughness: 0.2, metalness: 0.8 })));
        group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.35 })));
      }
    );

    // ── Resize ────────────────────────────────────────────────────────────
    this.onResize = () => {
      const nw = window.innerWidth, nh = window.innerHeight;
      canvas.width = nw; canvas.height = nh;
      canvas.style.width = nw + 'px'; canvas.style.height = nh + 'px';
      renderer.setSize(nw, nh, false);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      this.resizeAurora();
    };
    window.addEventListener('resize', this.onResize);
  }

  private loadScript(src: string): Promise<void> {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = () => res(); s.onerror = () => rej();
      document.head.appendChild(s);
    });
  }
  private onResize: () => void = () => {};

  // ── Mouse ─────────────────────────────────────────────────────────────────
  private onMouse = (e: MouseEvent): void => {
    this.targetMouseX = e.clientX / window.innerWidth;
    this.targetMouseY = 1 - e.clientY / window.innerHeight;
    this.parallaxTargetX = (e.clientX / window.innerWidth  - 0.5) * 2;
    this.parallaxTargetY = (e.clientY / window.innerHeight - 0.5) * -2;
  };
  private bindMouse(): void {
    window.addEventListener('mousemove', this.onMouse);
    const lerp = () => {
      this.mouseX += (this.targetMouseX - this.mouseX) * 0.04;
      this.mouseY += (this.targetMouseY - this.mouseY) * 0.04;
      requestAnimationFrame(lerp);
    };
    lerp();
  }

  // ── Typewriter ────────────────────────────────────────────────────────────
  private initTypewriter(): void {
    const go = (n: number) => {
      const el = document.querySelector<HTMLElement>('.typed-word');
      if (el) this.runTypewriter(el);
      else if (n > 0) requestAnimationFrame(() => go(n - 1));
    };
    go(10);
  }
  private runTypewriter(el: HTMLElement): void {
    const roles = ['Problem Solver', 'Software Developer', 'Systems Engineer – C1'];
    let ri = 0, ci = 0, del = false;
    const tick = () => {
      const w = roles[ri];
      if (!del) { el.textContent = w.slice(0, ++ci); if (ci >= w.length) { del = true; this.typingTimeout = setTimeout(tick, 1600); return; } }
      else { el.textContent = w.slice(0, --ci); if (ci <= 0) { del = false; ri = (ri + 1) % roles.length; } }
      this.typingTimeout = setTimeout(tick, del ? 36 : 78);
    };
    tick();
  }

  // ── Scroll reveal ─────────────────────────────────────────────────────────
  private initScrollAnimations(): void {
    setTimeout(() => {
      this.scrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const el = entry.target as HTMLElement;
          el.classList.add('visible');
          if (el.classList.contains('skill-bar-row')) {
            const f = el.querySelector<HTMLElement>('.skill-bar-fill');
            if (f) setTimeout(() => { const p = f.style.cssText.match(/--pct:\s*([\d.]+%)/)?.[1]; if (p) f.style.width = p; }, 250);
          }
          if (el.classList.contains('edu-card')) {
            const f = el.querySelector<HTMLElement>('.edu-card__bar-fill');
            if (f) setTimeout(() => { const p = f.style.cssText.match(/--pct:\s*([\d.]+%)/)?.[1]; if (p) f.style.width = p; }, 400);
          }
          if (el.classList.contains('experience-section')) {
            const sp = document.querySelector<HTMLElement>('.timeline-spine__fill');
            if (sp) setTimeout(() => sp.classList.add('active'), 300);
          }
          this.scrollObserver.unobserve(el);
        });
      }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
      ['.about-right','.about-stats','.chip','.skill-bar-row','.scroll-reveal','.reveal-section','.edu-card']
        .forEach(sel => document.querySelectorAll(sel).forEach(el => this.scrollObserver.observe(el)));
    }, 100);
  }
}