import axios from "axios";

export async function sendMessage(message: string, webhookUrl:string|undefined, formatted = true) {
    if(webhookUrl === undefined){
      throw new Error(`You are missing an env variable for discord hooks (eg TEAM_WEBHOOK, OUTDATED_WEBHOOK, SPIKE_WEBHOOK...) and this makes it impossible to send the following error message: "${message}"`)
    }
    const formattedMessage = formatted? "```\n" + message + "\n```" : message; // Put it into a code block to prevent the format from getting messed up
    if(formattedMessage.length >= 2000){
      const lines = message.split('\n')
      if(lines.length <= 2){
        throw new Error("Lines are too long, reaching infinite recursivity")
      }
      const mid = Math.round(lines.length/2)
      await sendMessage(lines.slice(0, mid).join('\n'), webhookUrl)
      await sendMessage(lines.slice(mid).join('\n'), webhookUrl)
      return
    }
    // Example: https://gist.github.com/dragonwocky/ea61c8d21db17913a43da92efe0de634
    // Docs: https://gist.github.com/dragonwocky/ea61c8d21db17913a43da92efe0de634
    await axios.post(
      `${webhookUrl}?wait=true`,
      {
        content: formattedMessage
      },
      {
        headers: {
          'Content-Type': 'application/json',
        }
      }
    ).then((body: any) => body.data)
    // console.log("discord", response)
}