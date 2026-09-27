// Adversarial: nested calls in defaults, closure params, generics, string delimiters.
class Svc {
    fun nestedDefault(a: Int = g(1, 2), b: String = h("x")): Int {
        return a
    }
    fun closureParam(cb: (Int) -> Int, n: Int): Int {
        return cb(n)
    }
    fun deepGenerics(m: Map<String, List<Pair<Int, String>>>): Int {
        return m.size
    }
    fun stringDelims(sep: String = ")", other: String = "// not a comment"): String {
        return sep + other
    }
    fun trailingComma(
        a: Int,
        b: Int,
    ): Int {
        return a + b
    }
}

// #738: a body-less declaration must not swallow the next class's body.
data class Dto(val id: String, val name: String)

class Consumer(private val dto: Dto) {
    fun consume(n: Int): String {
        return dto.id
    }
}
