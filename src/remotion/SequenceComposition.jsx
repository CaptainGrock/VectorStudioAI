// SequenceComposition: the sequencer's instant preview + stitch target.
// Each clip is one history scene (snapshot), laid back-to-back with
// per-item trims and gaps. Positions ripple by construction: every start
// is derived from the clips before it, so deleting or closing a gap
// pulls the rest of the rail in with no bookkeeping.
//
// Clips keep their own audio (TTS/music render as provided — a global bed
// plus a per-clip track simply mix, so keyframing the bed down lets a
// slide's music come forward). The sequence-level music lane below is a
// separate bed with its own volume keyframes across the whole timeline.
import React from 'react'
import { AbsoluteFill, Audio, Sequence, interpolate, useCurrentFrame } from 'remotion'
import { SceneComposition } from './SceneComposition.jsx'
import { clipDuration, seqCanvas } from '../store.js'

// Trim by shifting a copy: head/tail cuts become frame offsets on every
// layer bound and keyframe, so the existing SceneComposition (and its
// audio trimming) needs no sequence awareness at all.
function trimmedScene(item) {
  const scene = item.scene
  const dur = Number(scene?.durationInFrames) || 0
  const ts = Math.max(0, Math.round(Number(item.trimStart) || 0))
  const te = Math.max(0, Math.round(Number(item.trimEnd) || 0))
  const out = Math.max(1, dur - ts - te)
  return {
    ...scene,
    durationInFrames: out,
    layers: (scene.layers || []).map((l) => ({
      ...l,
      startFrame: Math.max(0, (Number(l.startFrame) || 0) - ts),
      endFrame: Math.max(0, (Number(l.endFrame) || 0) - ts),
      data: l.type === 'audio_tts' || l.type === 'audio_music'
        ? { ...(l.data || {}), offsetFrames: Math.max(0, Math.round(Number(l.data?.offsetFrames) || 0)) + ts }
        : l.data,
      keyframes: (l.keyframes || []).map((k) => ({ ...k, frame: (Number(k.frame) || 0) - ts })),
    })),
  }
}

function musicVolume(music, frame) {
  const kfs = [...(music?.keyframes || [])].sort((a, b) => a.frame - b.frame)
  if (!kfs.length) return 0.8
  const xs = kfs.map((k) => k.frame)
  const ys = kfs.map((k) => Number(k.properties?.volume ?? 0.8))
  return interpolate(frame, xs, ys, { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
}

export function SequenceComposition({ sequence }) {
  const items = sequence?.items || []
  const { width, height } = seqCanvas(sequence)
  let t = 0
  const clips = items.map((item) => {
    const dur = clipDuration(item)
    const start = t
    t += dur + Math.max(0, Math.round(Number(item.gapAfter) || 0))
    return { item, start, dur, scene: trimmedScene(item) }
  })
  const music = sequence?.music
  const musicOff = Math.max(0, Math.round(Number(music?.offsetFrames) || 0))
  return (
    <AbsoluteFill style={{ backgroundColor: '#05070c' }}>
      {clips.map(({ item, start, dur, scene }) => (
        <Sequence key={item.id} from={start} durationInFrames={dur} name={item.name}>
          <SceneComposition scene={scene} />
        </Sequence>
      ))}
      {music?.assetUrl && <SeqMusicVolume music={music} />}
    </AbsoluteFill>
  )
}

// Volume has to read the sequence playhead, so it lives in its own
// component under the composition root. Rendered volume follows the
// music lane's keyframes exactly as the keyframe dots show.
function SeqMusicVolume({ music }) {
  const frame = useCurrentFrame()
  const musicOff = Math.max(0, Math.round(Number(music?.offsetFrames) || 0))
  return <Audio src={music.assetUrl} startFrom={musicOff} volume={Math.min(2, Math.max(0, musicVolume(music, frame)))} />
}
