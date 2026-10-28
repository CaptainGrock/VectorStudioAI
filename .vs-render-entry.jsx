import { registerRoot } from 'remotion'
import React from 'react'
import { Composition } from 'remotion'
import { SceneComposition } from './src/remotion/SceneComposition.jsx'
import sceneData from './scene.json'
const RenderRoot = () => (
  <Composition id="vectorstudio" component={SceneComposition}
    durationInFrames={sceneData.durationInFrames || 300} fps={sceneData.fps || 30}
    width={Math.min(3840, Math.max(160, sceneData.width || 1280))} height={Math.min(3840, Math.max(160, sceneData.height || 720))} defaultProps={{ scene: sceneData }} />
)
registerRoot(RenderRoot)
