declare module 'aladin-lite' {
  interface AladinOptions {
    survey?: string;
    fov?: number;
    target?: string;
    showReticle?: boolean;
    showZoomControl?: boolean;
    showFullscreenControl?: boolean;
    showLayersControl?: boolean;
    showGotoControl?: boolean;
    showShareControl?: boolean;
    showStatusBar?: boolean;
    showFov?: boolean;
    showCooLocation?: boolean;
    showProjectionControl?: boolean;
    showCooGrid?: boolean;
    showFrame?: boolean;
    lockNorthUp?: boolean;
    inertia?: boolean;
    gridColor?: string;
    gridOpacity?: number;
    gridOptions?: {
      enabled?: boolean;
      showLabels?: boolean;
      thickness?: number;
      labelSize?: number;
    };
    reticleColor?: string;
    cooFrame?: string;
    projection?: string;
  }

  interface GraphicOverlayOptions {
    color?: string;
    lineWidth?: number;
    fillColor?: string;
  }

  interface CatalogOptions {
    name?: string;
    color?: string;
    sourceSize?: number;
    shape?: 'circle' | 'cross' | 'plus' | 'diamond' | 'square';
    displayLabel?: boolean;
    labelColor?: string;
    labelFont?: string;
  }

  interface AladinShape {
    setColor(color: string): void;
  }

  interface AladinSource {
    ra: number;
    dec: number;
    data: Record<string, unknown>;
  }

  interface AladinCatalog {
    addSources(sources: AladinSource[]): void;
    removeAll(): void;
  }

  interface GraphicOverlay {
    add(shape: AladinShape): void;
    removeAll(): void;
  }

  interface ImageHiPS {
    setAlpha(alpha: number): void;
    setBrightness(v: number): void;
    setContrast(v: number): void;
  }

  interface AladinInstance {
    on(event: string, handler: (e: { x: number; y: number } & Record<string, unknown>) => void): void;
    pix2world(x: number, y: number): [number, number];
    world2pix(c1: number, c2: number): [number, number];
    setFov(fov: number): void;
    gotoRaDec(ra: number, dec: number): void;
    getFov(): [number, number];
    getViewCenter(): [number, number];
    addOverlay(overlay: GraphicOverlay): void;
    addCatalog(catalog: AladinCatalog): void;
    setImageSurvey(surveyId: string): void;
    setImageLayer(image: ImageHiPS): void;
    getBaseImageLayer(): ImageHiPS;
  }

  interface AladinStatic {
    init: Promise<void>;
    aladin(container: HTMLElement | string, options?: AladinOptions): AladinInstance;
    graphicOverlay(options?: GraphicOverlayOptions): GraphicOverlay;
    circle(ra: number, dec: number, radiusDeg: number, options?: GraphicOverlayOptions): AladinShape;
    marker(ra: number, dec: number, options?: Record<string, unknown>): AladinShape;
    polyline(points: [number, number][], options?: GraphicOverlayOptions): AladinShape;
    catalog(options?: CatalogOptions): AladinCatalog;
    source(ra: number, dec: number, data?: Record<string, unknown>): AladinSource;
    imageHiPS(surveyId: string, options?: Record<string, unknown>): ImageHiPS;
  }

  const A: AladinStatic;
  export default A;
}
