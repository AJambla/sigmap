// Adversarial: nested defaults, closure params, generics, string delimiters.
class Svc {
    func nestedDefault(a: Int = g(1, 2), b: Int = h(3)) -> Int {
        return a
    }
    func closureParam(cb: (Int) -> Int, n: Int) -> Int {
        return cb(n)
    }
    func deepGenerics(m: [String: [Int]]) -> Int {
        return m.count
    }
    func stringDelims(sep: String = ")") -> String {
        return sep
    }
}

// #741: a nested type's methods belong to it, not to the enclosing type.
class Outer {
    func before(a: Int) -> Int { return a }
    class Inner {
        func handle(b: Int) -> Int { return b }
    }
    func after(c: Int) -> Int { return c }
}
