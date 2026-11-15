/* FOLD//MIX touch vinyl engine. Renders short local PCM windows forwards and backwards.
 * Receives touch destinations from the main thread; never uploads music.
 * This is a teaching/demo approximation, not hardware-grade DVS. */
class VinylTouchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left=null; this.right=null; this.head=0; this.target=0;
    this.active=false; this.motionAge=999999; this.velocity=0; this.envelope=0;
    this.port.onmessage = event => {
      const m=event.data;
      if (m.type==='load') {
        this.left = new Float32Array(m.left);
        this.right = new Float32Array(m.right);
        this.head = m.head || 0;
        this.target = this.head;
        this.velocity = 0;
        this.envelope = 0;
        this.motionAge=999999;
        this.active=true;
      } else if (m.type==='move') {
        this.target = Math.max(1, Math.min((this.left?.length||2)-2, m.head));
        this.motionAge=0;
      } else if (m.type==='stop') {
        this.active=false;
        this.motionAge=999999;
        this.velocity=0;
        this.envelope=0;
      }
    };
  }
  process(_inputs, outputs) {
    const out=outputs[0];
    if(!out?.length || !this.active || !this.left) {
      if(out)for(const chan of out)chan.fill(0);
      return true;
    }
    const left=out[0],right=out[1]||out[0];
    const len=this.left.length;
    for(let i=0;i<left.length;i++) {
      const delta=this.target-this.head;
      const desired = Math.abs(delta)<.2 ? 0 : Math.max(-7.5,Math.min(7.5,delta/48));
      this.velocity = this.velocity*.78 + desired*.22;
      const step=Math.abs(delta)<Math.abs(this.velocity)? delta : this.velocity;
      this.head=Math.max(1,Math.min(len-2,this.head+step));
      const traveling=this.motionAge<sampleRate*.065 && Math.abs(this.velocity)>.10;
      const level=traveling?Math.min(1,Math.abs(this.velocity)*1.8):0;
      this.envelope+= (level-this.envelope)*(traveling?.022:.009);
      const at=Math.max(1,Math.min(len-2,Math.floor(this.head)));
      const fraction=this.head-at;
      const l=this.left[at]+(this.left[at+1]-this.left[at])*fraction;
      const r=this.right[at]+(this.right[at+1]-this.right[at])*fraction;
      left[i]=l*this.envelope;
      right[i]=r*this.envelope;
      this.motionAge++;
    }
    return true;
  }
}
registerProcessor('vinyl-touch-processor', VinylTouchProcessor);
