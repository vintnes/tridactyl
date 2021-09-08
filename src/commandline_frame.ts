/** # Command line functions
 *
 * This file contains functions to interact with the command line.
 *
 * If you want to bind them to keyboard shortcuts, be sure to prefix them with "ex.". For example, if you want to bind control-p to `prev_completion`, use:
 *
 * ```
 * bind --mode=ex <C-p> ex.prev_completion
 * ```
 *
 * Note that you can also bind Tridactyl's [editor functions](/static/docs/modules/_src_lib_editor_.html) in the command line.
 *
 * Contrary to the main tridactyl help page, this one doesn't tell you whether a specific function is bound to something. For now, you'll have to make do with `:bind` and `:viewconfig`.
 *
 */
/** ignore this line */

/** Script used in the commandline iframe. Communicates with background. */

import * as SELF from "@src/commandline_frame"
import { CompletionSourceFuse } from "@src/completions"
import { AproposCompletionSource } from "@src/completions/Apropos"
import { BindingsCompletionSource } from "@src/completions/Bindings"
import { BmarkCompletionSource } from "@src/completions/Bmark"
import { CompositeCompletionSource } from "@src/completions/Composite"
import { ExcmdCompletionSource } from "@src/completions/Excmd"
import { ExtensionsCompletionSource } from "@src/completions/Extensions"
import { FileSystemCompletionSource } from "@src/completions/FileSystem"
import { GuisetCompletionSource } from "@src/completions/Guiset"
import { HelpCompletionSource } from "@src/completions/Help"
import { HistoryCompletionSource } from "@src/completions/History"
import { PreferenceCompletionSource } from "@src/completions/Preferences"
import { RssCompletionSource } from "@src/completions/Rss"
import { SessionsCompletionSource } from "@src/completions/Sessions"
import { SettingsCompletionSource } from "@src/completions/Settings"
import { BufferCompletionSource } from "@src/completions/Tab"
import { TabAllCompletionSource } from "@src/completions/TabAll"
import { ThemeCompletionSource } from "@src/completions/Theme"
import { WindowCompletionSource } from "@src/completions/Window"
import { contentState } from "@src/content/state_content"
import { theme } from "@src/content/styling"
import { getCommandlineFns } from "@src/lib/commandline_cmds"
import * as tri_editor from "@src/lib/editor"
import { html, render } from "htm/preact"
import Logger from "@src/lib/logging"
import * as Messaging from "@src/lib/messaging"
import "@src/lib/number.clamp"
import { euclid_mod } from "@src/lib/number.mod"
import * as genericParser from "@src/parsers/genericmode"
import * as perf from "@src/perf"
import state, * as State from "@src/state"
import * as R from "ramda"
import { KeyEventLike } from "./lib/keyseq"

let SELECTED_IND = 0

function next(){
    SELECTED_IND += 1
    refresh_completions()
}

function prev(){
    SELECTED_IND -= 1
    refresh_completions()
}

/** @hidden **/
const logger = new Logger("cmdline")

/** @hidden **/
const commandline_state = {
    activeCompletions: undefined as CompletionSourceFuse[],
    clInput: window.document.getElementById(
        "tridactyl-input",
    ) as HTMLInputElement,
    clear,
    cmdline_history_position: 0,
    completionsDiv: window.document.getElementById("completions"),
    fns: undefined as ReturnType<typeof getCommandlineFns>,
    getCompletion,
    history,
    /** @hidden
     * This is to handle Escape key which, while the cmdline is focused,
     * ends up firing both keydown and input listeners. In the worst case
     * hides the cmdline, shows and refocuses it and replaces its text
     * which could be the prefix to generate a completion.
     * tl;dr TODO: delete this and better resolve race condition
     */
    isVisible: false,
    keyEvents: new Array<KeyEventLike>(),
    refresh_completions,
    state,
    next,
    prev,
}

// first theming of commandline iframe
theme(document.querySelector(":root"))

/** @hidden **/
function resizeArea() {
    if (commandline_state.isVisible) {
        Messaging.messageOwnTab("commandline_content", "show")
        Messaging.messageOwnTab("commandline_content", "focus")
        focus()
    }
}

/** @hidden
 * This is a bit loosely defined at the moment.
 * Should work so long as there's only one completion source per prefix.
 */
function getCompletion(args_only = false) {
    if (!commandline_state.activeCompletions) return undefined

    for (const comp of commandline_state.activeCompletions) {
        if (comp.state === "normal" && comp.completion !== undefined) {
            return args_only ? comp.args : comp.completion
        }
    }
}
commandline_state.getCompletion = getCompletion

export function enableCompletions() {
    commandline_state.activeCompletions = []
    return refresh_completions()
}

export function refresh_completions(exstr) {
    const example_row = {
        contents: [ // What to display in the row, relative widths and classes for styling
            {text: "left", width: 1}, {text: "middle", width: 2, classes: ["url"]}, {text: "right"}
        ],
        completion: "left_right_middle", // What to insert if selected
        type: "Tabs", // The name of the heading
        score: 1, // score for sorting
        // focused: true, // shouldn't be set here
    }

    const example_row2 = {
        contents: [ // What to display in the row, relative widths and classes for styling
            {text: "leftless", width: 1}, {text: "middle", width: 2, classes: ["url"]}, {text: "right"}
        ],
        completion: "left_right_middle", // What to insert if selected
        type: "Tabs", // The name of the heading
        score: 0, // score for sorting. higher is better. #decisive
    }
    
    const example_row3 = {
        contents: [ // What to display in the row, relative widths and classes for styling
            {text: "leftless", width: 1}, {text: "middle", width: 2, classes: ["url"]}, {text: "right"}
        ],
        completion: "left_right_middle", // What to insert if selected
        type: "Flabs", // The name of the heading
        score: 0, // score for sorting. higher is better. #decisive
    }

    const norm_widths = row => {
        const total = R.pipe(R.map(R.pipe(R.propOr(1, "width"), parseFloat)), R.sum)(row.contents)
        for (const cell of row.contents) {
            cell.width = (parseFloat(cell.width ?? 1) / total) * 100 + "%"
        }
        return row
    }


    // This needs to sort by type + score
    // i.e. it should be in the same order that it appears
    const rows = R.sortBy(R.propOr(0, "score"))([example_row, example_row2, example_row3])
    const sources = {}
    for (const row of rows) {
        if (sources[row.type] === undefined)
            sources[row.type] = []
        sources[row.type].push(row)
    }

    rows[euclid_mod(SELECTED_IND,rows.length)]["focused"] = true


    const row2tr = row => {
        row = norm_widths(row)
        return html`<tr class="${row.focused ? "focused" : ""}">${row.contents.map(o =>
            html`<td style="width:${o.width}" class="${o.classes?.join(" ") ?? ""}">${o.text}</td>`
        )}</tr>`
    }

    const sources2table = sources => {
        return html`
            <table style='width:100%'>
                ${
                    Object.entries(sources).map(([source, rows]) => {
                        return html`
                            <th>${source}</th>
                            ${rows.map(r => row2tr(r))}
                        `
                    })
                }
            </table>
        `
    }

    render(
        sources2table(sources),
        commandline_state.completionsDiv,
    )

    // What is a completion source?
    //      function that takes filter text and returns array of objects with score for sorting, completion type, completion value, table rows and widths
    //
    //  Completion boss:
    //      - which row is selected; which completion it belongs to
    //          -> adding / removing css tags?
    //              -> completions are not in charge of what is selected
    //                  it's the job of the completion boss
    //      - execute commands on completion rows
    //          -> maybe allow multi-select?
    //
    //      - questions: 
    //          - how can we add a 
    //          (( this is the problem with stopping in the middle of something, I can't remember what I was writing. I'll just stare at this for a few minutes until I remember. Bear with me ...))
    //          - ideally themes would be able to override the width
    //
    //  i.e. completion sources no longer handle html or styling directly, except for row width weight
}
/* document.addEventListener("DOMContentLoaded", enableCompletions) */

/** @hidden **/
const noblur = () => setTimeout(() => commandline_state.clInput.focus(), 0)

/** @hidden **/
export function focus() {
    commandline_state.clInput.focus()
    commandline_state.clInput.removeEventListener("blur", noblur)
    commandline_state.clInput.addEventListener("blur", noblur)
}

/** @hidden **/
let HISTORY_SEARCH_STRING: string

/** @hidden
 * Command line keybindings
 **/
const keyParser = keys => genericParser.parser("exmaps", keys)
/** @hidden **/
let history_called = false
/** @hidden **/
let prev_cmd_called_history = false

// Save programmer time by generating an immediately resolved promise
// eslint-disable-next-line @typescript-eslint/no-empty-function
const QUEUE: Promise<any>[] = [(async () => {})()]

/** @hidden **/
commandline_state.clInput.addEventListener(
    "keydown",
    function (keyevent: KeyboardEvent) {
        if (!keyevent.isTrusted) return
        commandline_state.keyEvents.push(keyevent)
        const response = keyParser(commandline_state.keyEvents)
        if (response.isMatch) {
            keyevent.preventDefault()
            keyevent.stopImmediatePropagation()
        } else {
            // Ideally, all keys that aren't explicitly bound to an ex command
            // should be bound to a "self-insert" command that would input the
            // key itself. Because it's not possible to generate events as if
            // they originated from the user, we can't do this, but we still
            // need to simulate it, in order to have history() work.
            prev_cmd_called_history = false
        }
        if (response.value) {
            commandline_state.keyEvents = []
            history_called = false

            // If excmds start with 'ex.' they're coming back to us anyway, so skip that.
            // This is definitely a hack. Should expand aliases with exmode, etc.
            // but this whole thing should be scrapped soon, so whatever.
            if (response.value.startsWith("ex.")) {
                const [funcname, ...args] = response.value.slice(3).split(/\s+/)

                QUEUE[QUEUE.length - 1].then(() => {
                    QUEUE.push(
                        // Abuse async to wrap non-promises in a promise
                        // eslint-disable-next-line @typescript-eslint/require-await
                        (async () =>
                            commandline_state.fns[
                                funcname as keyof typeof commandline_state.fns
                            ](
                                args.length === 0 ? undefined : args.join(" "),
                            ))(),
                    )
                    prev_cmd_called_history = history_called
                })
            } else {
                // Send excmds directly to our own tab, which fixes the
                // old bug where a command would be issued in one tab but
                // land in another because the active tab had
                // changed. Background-mode excmds will be received by the
                // own tab's content script and then bounced through a
                // shim to the background, but the latency increase should
                // be acceptable becuase the background-mode excmds tend
                // to be a touch less latency-sensitive.
                Messaging.messageOwnTab("controller_content", "acceptExCmd", [
                    response.value,
                ]).then(_ => (prev_cmd_called_history = history_called))
            }
        } else {
            commandline_state.keyEvents = response.keys
        }
    },
    true,
)


/** @hidden **/
let onInputPromise: Promise<any> = Promise.resolve()
/** @hidden **/
commandline_state.clInput.addEventListener("input", () => {
    const exstr = commandline_state.clInput.value
    contentState.current_cmdline = exstr
    contentState.cmdline_filter = ""
    // Schedule completion computation. We do not start computing immediately because this would incur a slow down on quickly repeated input events (e.g. maintaining <Backspace> pressed)
    setTimeout(async () => {
        // Make sure the previous computation has ended
        await onInputPromise
        // If we're not the current completion computation anymore, stop
        if (exstr !== commandline_state.clInput.value) {
            contentState.cmdline_filter = exstr
            return
        }

        onInputPromise = refresh_completions(exstr)
        onInputPromise.then(() => {
            contentState.cmdline_filter = exstr
        })
    }, 100)
})

/** @hidden **/
let cmdline_history_current = ""

/** @hidden
 * Clears the command line.
 * If you intend to close the command line after this, set evlistener to true in order to enable losing focus.
 *  Otherwise, no need to pass an argument.
 */
export function clear(evlistener = false) {
    if (evlistener)
        commandline_state.clInput.removeEventListener("blur", noblur)
    commandline_state.clInput.value = ""
    commandline_state.cmdline_history_position = 0
    cmdline_history_current = ""
}
commandline_state.clear = clear

/** @hidden **/
async function history(n) {
    history_called = true

    if (!prev_cmd_called_history) {
        HISTORY_SEARCH_STRING = commandline_state.clInput.value
    }

    // Check for matches in history, removing duplicates
    const matches = R.reverse(
        R.uniq(R.reverse(await State.getAsync("cmdHistory"))),
    ).filter(key => key.startsWith(HISTORY_SEARCH_STRING))
    if (commandline_state.cmdline_history_position === 0) {
        cmdline_history_current = commandline_state.clInput.value
    }
    let clamped_ind =
        matches.length + n - commandline_state.cmdline_history_position
    clamped_ind = clamped_ind.clamp(0, matches.length)

    const pot_history = matches[clamped_ind]
    commandline_state.clInput.value =
        pot_history === undefined ? cmdline_history_current : pot_history

    // if there was no clampage, update history position
    // there's a more sensible way of doing this but that would require more programmer time
    if (
        clamped_ind ===
        matches.length + n - commandline_state.cmdline_history_position
    )
        commandline_state.cmdline_history_position =
            commandline_state.cmdline_history_position - n
}
commandline_state.history = history

/** @hidden **/
export function fillcmdline(
    newcommand?: string,
    trailspace = true,
    ffocus = true,
) {
    if (trailspace) commandline_state.clInput.value = newcommand + " "
    else commandline_state.clInput.value = newcommand
    commandline_state.isVisible = true
    let result = Promise.resolve([])
    // Focus is lost for some reason.
    if (ffocus) {
        focus()
        result = refresh_completions(commandline_state.clInput.value)
    }
    return result
}

/** @hidden **/
export function getContent() {
    return commandline_state.clInput.value
}

/** @hidden **/
export function editor_function(fn_name: keyof typeof tri_editor, ...args) {
    let result = Promise.resolve([])
    if (tri_editor[fn_name]) {
        tri_editor[fn_name](commandline_state.clInput, ...args)
        result = refresh_completions(commandline_state.clInput.value)
    } else {
        // The user is using the command line so we can't log message there
        // logger.error(`No editor function named ${fn_name}!`)
        console.error(`No editor function named ${fn_name}!`)
    }
    return result
}

Messaging.addListener("commandline_frame", Messaging.attributeCaller(SELF))

commandline_state.fns = getCommandlineFns(commandline_state)
Messaging.addListener(
    "commandline_cmd",
    Messaging.attributeCaller(commandline_state.fns),
)

// Listen for statistics from the commandline iframe and send them to
// the background for collection. Attach the observer to the window
// object since there's apparently a bug that causes performance
// observers to be GC'd even if they're still the target of a
// callback.
;(window as any).tri = Object.assign(window.tri || {}, {
    perfObserver: perf.listenForCounters(),
})
