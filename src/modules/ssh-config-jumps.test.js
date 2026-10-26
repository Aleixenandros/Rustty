import { describe, expect, it } from "vitest";
import { linkSshConfigJumps, sshConfigJumpFields, firstBlockPerAlias } from "./ssh-config-jumps.js";

const ids = (...aliases) => new Map(aliases.map((a) => [a, `id-${a}`]));

describe("linkSshConfigJumps", () => {
  it("enlaza un ProxyJump que es el alias de otro Host del lote", () => {
    const blocks = [{ alias: "bastion" }, { alias: "web", proxyJump: "bastion" }];
    expect(linkSshConfigJumps(blocks, ids("bastion", "web"))).toEqual(new Map([["web", "id-bastion"]]));
  });

  it("deja como texto lo que no es un único alias del lote", () => {
    const blocks = [
      { alias: "bastion" },
      { alias: "a", proxyJump: "ops@bastion" },
      { alias: "b", proxyJump: "bastion:2222" },
      { alias: "c", proxyJump: "bastion,otro" },
      { alias: "d", proxyJump: "fuera.example.com" },
      { alias: "e", proxyJump: "none" },
      { alias: "f", proxyJump: "  " },
    ];
    expect(linkSshConfigJumps(blocks, ids("bastion", "a", "b", "c", "d", "e", "f")).size).toBe(0);
  });

  it("no enlaza un bloque consigo mismo ni un ciclo de bastiones", () => {
    const blocks = [
      { alias: "yo", proxyJump: "yo" },
      { alias: "a", proxyJump: "b" },
      { alias: "b", proxyJump: "a" },
      { alias: "c", proxyJump: "a" },
    ];
    const links = linkSshConfigJumps(blocks, ids("yo", "a", "b", "c"));
    // c salta por a, que está en un ciclo: c sí se enlaza (la conexión dirá
    // que la cadena de a no se puede montar); a y b quedan como texto.
    expect(links).toEqual(new Map([["c", "id-a"]]));
  });

  it("encadena bastiones del mismo fichero", () => {
    const blocks = [{ alias: "a" }, { alias: "b", proxyJump: "a" }, { alias: "c", proxyJump: "b" }];
    expect(linkSshConfigJumps(blocks, ids("a", "b", "c"))).toEqual(
      new Map([["b", "id-a"], ["c", "id-b"]]),
    );
  });
});

describe("sshConfigJumpFields", () => {
  const links = new Map([["web", "id-bastion"]]);
  it("con enlace, perfil y sin texto", () => {
    expect(sshConfigJumpFields({ alias: "web", proxyJump: "bastion" }, links))
      .toEqual({ proxy_jump: null, proxy_jump_profile_id: "id-bastion" });
  });
  it("con otro ProxyJump, el texto y sin perfil", () => {
    expect(sshConfigJumpFields({ alias: "db", proxyJump: " ops@gw " }, links))
      .toEqual({ proxy_jump: "ops@gw", proxy_jump_profile_id: null });
  });
  it("sin ProxyJump no toca el bastión de perfil", () => {
    const fields = sshConfigJumpFields({ alias: "db" }, links);
    expect(fields).toEqual({ proxy_jump: null });
    expect("proxy_jump_profile_id" in fields).toBe(false);
  });
});

describe("firstBlockPerAlias", () => {
  it("con un Host repetido se queda el primero y lo cuenta", () => {
    const blocks = [
      { alias: "a", proxyJump: "b" },
      { alias: "b" },
      { alias: "a", proxyJump: null },
      { alias: "a" },
    ];
    const { blocks: kept, duplicates } = firstBlockPerAlias(blocks);
    expect(kept).toEqual([blocks[0], blocks[1]]);
    expect(duplicates).toEqual(["a"]);
  });

  it("sin repetidos devuelve los mismos bloques y los ids no chocan", () => {
    const blocks = [{ alias: "a" }, { alias: "b", proxyJump: "a" }];
    const { blocks: kept, duplicates } = firstBlockPerAlias(blocks);
    expect(kept).toEqual(blocks);
    expect(duplicates).toEqual([]);
    const ids = new Map(kept.map((b, i) => [b.alias, `id-${i}`]));
    expect(linkSshConfigJumps(kept, ids)).toEqual(new Map([["b", "id-0"]]));
  });
});
