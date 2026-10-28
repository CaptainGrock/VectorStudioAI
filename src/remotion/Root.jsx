import React from 'react'
import { Composition } from 'remotion'
import { SceneComposition } from './SceneComposition.jsx'
import { defaultScene } from '../sceneGraph.js'

export function RemotionRoot() {
  return (
    <Composition
      id="vectorstudio"
      component={SceneComposition}
      durationInFrames={defaultScene.durationInFrames}
      fps={defaultScene.fps}
      width={1280}
      height={720}
      defaultProps={{ scene: defaultScene }}
    />
  )
}
